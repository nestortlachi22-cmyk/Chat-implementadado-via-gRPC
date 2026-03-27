const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

// ============================================
// gRPC Setup
// ============================================
const PROTO_PATH = path.join(__dirname, 'mensajeria.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const mensajeriaProto = grpc.loadPackageDefinition(packageDefinition).mensajeria;

// ============================================
// Estado Global (Solo gRPC)
// ============================================
// Guardamos los clientes gRPC en espera
let clientesEsperando = [];

// ---- Funciones Base ----
const difundirATodos = (mensaje, rpcType) => {
    mensaje.tipo = rpcType;
    // Difusión total: alcanza a todos los clientes polling activos para asegurar
    // que las conversaciones se creen dinámicamente en todos los extremos.
    clientesEsperando.forEach(cliente => cliente.callback(mensaje));
    clientesEsperando = [];
    return { status: `${rpcType.replace('[', '').replace(']', '').toLowerCase()} enviado` };
};

const enviarBroadcast = (mensaje) => difundirATodos(mensaje, "[BROADCAST]");

const enviarMulticast = (mensaje) => {
    mensaje.tipo = "[MULTICAST]";
    // Filtramos para enviar SOLO a los inscritos en la sala (incluyendo unicasts que son "salas" de nombre de usuario)
    const destinatarios = clientesEsperando.filter(c => c.sala === mensaje.sala);
    destinatarios.forEach(cliente => cliente.callback(mensaje));
    // Limpiamos de la cola a quienes despachamos el mensaje
    clientesEsperando = clientesEsperando.filter(c => c.sala !== mensaje.sala);
    return { status: 'Multicast enviado a la sala ' + mensaje.sala };
};

const enviarAnycast = (mensaje) => {
    mensaje.tipo = "[ANYCAST]";
    const salaDestino = mensaje.sala;
    const indice = clientesEsperando.findIndex(c => c.sala === salaDestino);
    if (indice !== -1) {
        const cliente = clientesEsperando[indice];
        cliente.callback(mensaje);
        clientesEsperando.splice(indice, 1);
        return { status: 'Anycast enviado al primer disponible', error: '' };
    } else {
        return { status: 'Nadie disponible', error: '404' };
    }
};

// ============================================
// API gRPC
// ============================================

function grpcPoll(call, callbackGrpc) {
    const sala = call.request.sala;
    const tipo_sala = call.request.tipo_sala;
    const callback = (mensaje) => {
        callbackGrpc(null, {
            tipo: mensaje.tipo,
            sala: mensaje.sala || sala,
            contenido: JSON.stringify(mensaje)
        });
    };

    const id = call;
    clientesEsperando.push({ callback, sala, id, tipo_sala });

    call.on('cancelled', () => {
        clientesEsperando = clientesEsperando.filter(cliente => cliente.id !== id);
    });
}

function parseGrpcContent(requestMsg) {
    let payload = { sala: requestMsg.sala };
    if (requestMsg.contenido) {
        try {
            Object.assign(payload, JSON.parse(requestMsg.contenido));
        } catch (e) {
            payload.mensajeData = requestMsg.contenido;
        }
    }
    return payload;
}

function grpcEnviarBroadcast(call, callbackGrpc) {
    const payload = parseGrpcContent(call.request);
    payload.sala = "*"; // Forzamos sala global para broadcast
    const result = enviarBroadcast(payload);
    callbackGrpc(null, result);
}

function grpcEnviarMulticast(call, callbackGrpc) {
    const payload = parseGrpcContent(call.request);
    const result = enviarMulticast(payload);
    callbackGrpc(null, result);
}

function grpcEnviarAnycast(call, callbackGrpc) {
    const payload = parseGrpcContent(call.request);
    const result = enviarAnycast(payload);
    if (result.error) {
        callbackGrpc({
            code: grpc.status.NOT_FOUND,
            details: result.status
        });
    } else {
        callbackGrpc(null, result);
    }
}
function grpcListarUsuarios(call, callbackGrpc) {
    const usuarios = [...new Set(clientesEsperando.filter(c => c.tipo_sala === 'unicast').map(c => c.sala))];
    callbackGrpc(null, { items: usuarios });
}

function grpcListarSalas(call, callbackGrpc) {
    const salas = [...new Set(clientesEsperando.filter(c => c.tipo_sala === 'multicast' || c.tipo_sala === 'anycast').map(c => c.sala))];
    callbackGrpc(null, { items: salas });
}


// Inicialización
// ============================================

const PORT_GRPC = 50051;
const grpcServer = new grpc.Server();
grpcServer.addService(mensajeriaProto.Mensajeria.service, {
    Poll: grpcPoll,
    EnviarBroadcast: grpcEnviarBroadcast,
    EnviarMulticast: grpcEnviarMulticast,
    EnviarAnycast: grpcEnviarAnycast,
    ListarUsuarios: grpcListarUsuarios,
    ListarSalas: grpcListarSalas
});

grpcServer.bindAsync(`0.0.0.0:${PORT_GRPC}`, grpc.ServerCredentials.createInsecure(), (error, port) => {
    if (error) {
        console.error("Error iniciando gRPC:", error);
        return;
    }
    console.log(`Servidor iniciado. Operando solo con RPC en puerto ${port}`);
});