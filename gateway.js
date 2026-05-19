const express = require('express');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ==========================================
// 1. CONFIGURACIÓN DEL CLIENTE gRPC
// ==========================================
const PROTO_PATH = path.join(__dirname, 'mensajeria.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const mensajeriaProto = grpc.loadPackageDefinition(packageDefinition).mensajeria;

// Nos conectamos al Backend gRPC (server.js)
const GRPC_SERVER = process.env.GRPC_SERVER || '127.0.0.1:50051';
const client = new mensajeriaProto.Mensajeria(GRPC_SERVER, grpc.credentials.createInsecure());

function esIPv4Privada(ip) {
    return ip.startsWith('192.168.')
        || ip.startsWith('10.')
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}

function esIPv4LinkLocal(ip) {
    return ip.startsWith('169.254.');
}

function esIPv4Valida(ip) {
    return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(ip);
}

function esInterfazVirtual(nombre) {
    return /(virtual|vethernet|vmware|vbox|virtualbox|docker|wsl|hyper-v|loopback|tunnel|tap|vpn|tailscale|zerotier|hamachi|bluetooth|npcap)/i.test(nombre);
}

function esMACVirtual(mac = '') {
    return /^(00:05:69|00:0c:29|00:1c:14|00:50:56|08:00:27|0a:00:27|00:15:5d)/i.test(mac);
}

function obtenerTipoInterfaz(nombre) {
    if (/(wi-?fi|wireless|wlan|802\.11|airport)/i.test(nombre)) return 'Wi-Fi';
    if (/(ethernet|^eth\d*|^enp\d|^ens\d|^eno\d|lan)/i.test(nombre)) return 'Ethernet';
    return 'Red local';
}

function ejecutarComandoRed(comando) {
    try {
        return execSync(comando, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1500
        });
    } catch (error) {
        return '';
    }
}

function obtenerIPv4RutaWindows() {
    const salida = ejecutarComandoRed('route print -4 0.0.0.0');
    const rutas = salida.split(/\r?\n/)
        .map((linea) => linea.trim().split(/\s+/))
        .filter((partes) => partes[0] === '0.0.0.0' && partes[1] === '0.0.0.0' && esIPv4Valida(partes[3]))
        .map((partes) => ({
            ip: partes[3],
            metrica: Number.parseInt(partes[4], 10) || Number.MAX_SAFE_INTEGER
        }));

    rutas.sort((a, b) => a.metrica - b.metrica);
    return rutas[0]?.ip || null;
}

function obtenerIPv4RutaLinux() {
    const salidaRuta = ejecutarComandoRed('ip route get 1.1.1.1');
    const ipRuta = salidaRuta.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1];
    if (ipRuta && esIPv4Valida(ipRuta)) return ipRuta;

    const salidaDefault = ejecutarComandoRed('ip route show default');
    const ipDefault = salidaDefault.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1];
    return ipDefault && esIPv4Valida(ipDefault) ? ipDefault : null;
}

function obtenerIPv4RutaPrincipal() {
    if (process.platform === 'win32') return obtenerIPv4RutaWindows();
    if (process.platform === 'linux') return obtenerIPv4RutaLinux();
    return null;
}

function puntuarInterfaz(candidato) {
    let puntos = 0;

    if (candidato.esRutaPrincipal) puntos += 200;
    if (candidato.esPrivada) puntos += 100;
    if (candidato.ip.startsWith('192.168.')) puntos += 20;
    if (candidato.ip.startsWith('10.')) puntos += 15;
    if (/^172\./.test(candidato.ip)) puntos += 10;

    if (candidato.tipo === 'Wi-Fi') puntos += 40;
    else if (candidato.tipo === 'Ethernet') puntos += 35;
    else puntos += 5;

    if (candidato.esVirtual) puntos -= 100;
    if (candidato.esMACVirtual) puntos -= 80;
    if (candidato.esLinkLocal) puntos -= 80;

    return puntos;
}

function obtenerRedLocal() {
    const interfaces = os.networkInterfaces();
    const candidatos = [];
    const ipRutaPrincipal = obtenerIPv4RutaPrincipal();

    Object.entries(interfaces).forEach(([nombre, items = []]) => {
        items.forEach((item) => {
            if ((item.family === 'IPv4' || item.family === 4) && !item.internal) {
                const candidato = {
                    ip: item.address,
                    nombre,
                    mac: item.mac,
                    tipo: obtenerTipoInterfaz(nombre),
                    esPrivada: esIPv4Privada(item.address),
                    esLinkLocal: esIPv4LinkLocal(item.address),
                    esVirtual: esInterfazVirtual(nombre),
                    esMACVirtual: esMACVirtual(item.mac),
                    esRutaPrincipal: item.address === ipRutaPrincipal
                };

                candidato.puntos = puntuarInterfaz(candidato);
                candidatos.push(candidato);
            }
        });
    });

    candidatos.sort((a, b) => b.puntos - a.puntos);

    return {
        principal: candidatos[0] || {
            ip: '127.0.0.1',
            nombre: 'localhost',
            mac: '00:00:00:00:00:00',
            tipo: 'Solo esta PC',
            esPrivada: false,
            esLinkLocal: false,
            esVirtual: false,
            esMACVirtual: false,
            esRutaPrincipal: false,
            puntos: 0
        },
        alternativas: candidatos.slice(1)
            .filter((candidato) => candidato.esPrivada && !candidato.esLinkLocal && !candidato.esVirtual && !candidato.esMACVirtual)
            .slice(0, 3)
    };
}

function obtenerPuertoGrpc(grpcServer) {
    return grpcServer.split(':').pop() || '50051';
}

// ==========================================
// 2. CONFIGURACIÓN DEL API GATEWAY (HTTP)
// ==========================================
const app = express();
app.use(express.json());

// Servimos el HTML al navegador
app.use(express.static(path.join(__dirname, 'public')));



// El navegador hace GET /poll/:sala. Nosotros, como Gateway, lo traducimos a un Poll en gRPC.
app.get('/poll/:sala', (req, res) => {
    const sala = req.params.sala;
    const tipo_sala = req.query.tipo || 'unicast'; // Leemos "unicast" o "multicast"

    // Hablamos con el Backend mediante gRPC
    const call = client.Poll({ sala: sala, tipo_sala: tipo_sala }, (error, response) => {
        if (error) {
            // Manejamos si la conexión falla o se cancela
            if (error.code === grpc.status.CANCELLED) return res.end();
            if (!res.headersSent) {
                return res.status(502).json({ error: 'Error comunicándose con Backend gRPC.' });
            }
            return;
        }

        // Traducimos el paquete gRPC a un JSON amigable para index.html
        let data = { usuario: 'Anónimo', texto: '' };
        if (response.contenido) {
            try { data = JSON.parse(response.contenido); } catch (e) { data.texto = response.contenido; }
        }

        res.json({
            tipo: response.tipo,
            usuario: data.usuario,
            sala: response.sala,
            texto: data.texto,
            id: data.id, // Añadimos el identificador de mensaje
            isUnicast: data.isUnicast // Pasamos el flag unicast al frontend
        });
    });

    // Detectar si el usuario cierra la pestaña aborta el poll anticipadamente
    req.on('close', () => {
        if (!res.writableEnded) {
            call.cancel();
        }
    });
});

// El navegador hace POST /enviar/broadcast. Nosotros enviamos el dato por gRPC.
app.post('/enviar/:metodo', (req, res) => {
    const metodo = req.params.metodo;
    const payload = {
        sala: req.body.sala,
        contenido: JSON.stringify(req.body) // Pasamos el cuerpo completo (incluye el ID)
    };

    const handler = (error, response) => {
        if (error) {
            return res.status(error.code === grpc.status.NOT_FOUND ? 404 : 500).json({ error: error.details });
        }
        res.status(200).json({ status: response.status });
    };

    // Traducimos la petición HTTP en su método RPC correspondiente
    if (metodo === 'broadcast') {
        // Enviar solo el contenido para el nuevo formato MensajeGlobal
        client.EnviarBroadcast({ contenido: payload.contenido }, handler);
    } else if (metodo === 'multicast') {
        client.EnviarMulticast(payload, handler);
    } else if (metodo === 'anycast') {
        client.EnviarAnycast(payload, handler);
    } else {
        res.status(400).json({ error: 'Método no válido' });
    }
});

app.get('/listado/usuarios', (req, res) => {
    client.ListarUsuarios({}, (err, response) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(response.items || []);
    });
});

app.get('/listado/salas', (req, res) => {
    client.ListarSalas({}, (err, response) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(response.items || []);
    });
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    const redLocal = obtenerRedLocal();
    const ipLocal = redLocal.principal.ip;
    const puertoGrpc = obtenerPuertoGrpc(GRPC_SERVER);
    const urlRedLocal = `http://${ipLocal}:${PORT}`;
    const detalleRedLocal = `${redLocal.principal.tipo}: ${redLocal.principal.nombre}`;
    const urlsAlternativas = redLocal.alternativas
        .map((candidato) => `http://${candidato.ip}:${PORT} (${candidato.tipo}: ${candidato.nombre})`)
        .join(' | ');

    console.log(`📡 Interfaz detectada: ${detalleRedLocal}`);
    if (urlsAlternativas) {
        console.log(`🧭 Otras IPs LAN detectadas: ${urlsAlternativas}`);
    }
    console.log(`🚀 API Gateway Iniciado en el puerto ${PORT}`);
    console.log(`🌐 Abierto a Navegadores (Frontend HTML): ${urlRedLocal} (${detalleRedLocal})`);
    console.log(`🔗 Usando el Backend gRPC en ${GRPC_SERVER} | IP local: ${ipLocal}:${puertoGrpc}`);
});
