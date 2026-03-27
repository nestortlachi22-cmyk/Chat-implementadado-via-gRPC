const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, 'mensajeria.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const mensajeriaProto = grpc.loadPackageDefinition(packageDefinition).mensajeria;

// Crear el cliente conectado a nuestro servidor gRPC
const GRPC_SERVER = process.env.GRPC_SERVER || '127.0.0.1:50051';
const client = new mensajeriaProto.Mensajeria(GRPC_SERVER, grpc.credentials.createInsecure());

console.log(`Conectado al servidor RPC en ${GRPC_SERVER}`);

// 1. Función para quedarse "escuchando" en una sala (Sistemas)
function escucharMensajes() {
    client.Poll({ sala: "Sistemas" }, (error, response) => {
        if (!error) {
            let data = {};
            try { data = JSON.parse(response.contenido); } catch(e) { data.texto = response.contenido; }
            
            console.log(`\n📩 [NUEVO MENSAJE] Tipo: ${response.tipo} | Sala: ${response.sala}`);
            console.log(`🗣️ Usuario: ${data.usuario || 'Anónimo'} -> "${data.texto || ''}"`);
        } else {
            console.error("Error al escuchar:", error.message);
        }
        
        // Al recibir (o fallar), nos volvemos a suscribir inmediatamente
        escucharMensajes();
    });
}

// Iniciar escucha
escucharMensajes();


// 2. Funciones de prueba automatizada para demostrar que funciona
setTimeout(() => {
    console.log("\n[TEST] -> Enviando mensaje BROADCAST...");
    const payload = JSON.stringify({ usuario: "ClienteTest", texto: "Hola, esto es un Broadcast puro en RPC!" });
    
    client.EnviarBroadcast({ contenido: payload }, (error, response) => {
        if (!error) console.log("✅ Servidor respondió:", response.status);
    });
}, 2000);

setTimeout(() => {
    console.log("\n[TEST] -> Enviando mensaje MULTICAST a Sala 'Sistemas'...");
    const payload = JSON.stringify({ usuario: "ClienteTest", texto: "Mensaje Exclusivo para la sala Sistemas" });
    
    client.EnviarMulticast({ sala: "Sistemas", contenido: payload }, (error, response) => {
        if (!error) console.log("✅ Servidor respondió:", response.status);
    });
}, 4000);
