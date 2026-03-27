const express = require('express');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

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
    console.log(`🚀 API Gateway Iniciado en el puerto ${PORT}`);
    console.log(`🌐 Abierto a Navegadores (Frontend HTML) en el puerto ${PORT}`);
    console.log(`🔗 Usando el Backend gRPC en ${GRPC_SERVER}`);
});
