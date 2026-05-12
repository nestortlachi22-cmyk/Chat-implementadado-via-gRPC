# Uso de sockets en el proyecto

Este proyecto no usa `WebSocket` ni crea sockets manualmente con `net.Socket`.
El uso de sockets ocurre de forma indirecta por medio de:

- gRPC, que abre conexiones TCP/HTTP2 entre cliente y servidor.
- Express/HTTP, que abre un socket TCP para recibir peticiones del navegador.
- `fetch`, que usa HTTP desde el navegador hacia el gateway.

Flujo general:

```text
Navegador
   |
   | HTTP / fetch
   v
gateway.js  puerto 3000
   |
   | gRPC sobre TCP/HTTP2
   v
server.js   puerto 50051
```

## 1. Contrato RPC que define las llamadas de red

Archivo: `mensajeria.proto`

```proto
service Mensajeria {
  rpc Poll (Suscripcion) returns (Mensaje);
  rpc EnviarBroadcast (MensajeGlobal) returns (Respuesta);
  rpc EnviarMulticast (MensajeEnvio) returns (Respuesta);
  rpc EnviarAnycast (MensajeEnvio) returns (Respuesta);
  rpc ListarUsuarios (Vacio) returns (Lista);
  rpc ListarSalas (Vacio) returns (Lista);
}
```

Este archivo define las operaciones remotas que viajaran por la conexion gRPC.
No abre el socket por si mismo, pero funciona como el contrato que cliente y servidor usan para comunicarse.

La llamada mas importante para simular recepcion en tiempo real es:

```proto
rpc Poll (Suscripcion) returns (Mensaje);
```

`Poll` mantiene una peticion esperando hasta que haya un mensaje. Esto se parece a un socket en comportamiento, porque deja una conexion abierta por un tiempo, pero tecnicamente es una llamada gRPC unary prolongada.

## 2. Servidor gRPC escuchando en un puerto

Archivo: `server.js`

```js
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
```

Aqui es donde el backend abre el puerto `50051`.
Internamente, gRPC crea un servidor que escucha conexiones de red. Ese servidor usa sockets TCP debajo, aunque el codigo no los manipule directamente.

La direccion:

```js
`0.0.0.0:${PORT_GRPC}`
```

significa que el servidor acepta conexiones desde cualquier interfaz de red de la maquina.

## 3. Clientes esperando mensajes mediante long polling gRPC

Archivo: `server.js`

```js
let clientesEsperando = [];

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
```

Esta es una de las partes clave del comportamiento tipo socket.

Cuando un cliente llama a `Poll`, el servidor no responde inmediatamente. Guarda el `callbackGrpc` dentro de `clientesEsperando`.

```js
clientesEsperando.push({ callback, sala, id, tipo_sala });
```

Eso deja al cliente "colgado" esperando una respuesta. Cuando llega un mensaje, el servidor ejecuta el callback y responde por la conexion gRPC abierta.

Tambien se maneja cuando el cliente cierra la conexion:

```js
call.on('cancelled', () => {
    clientesEsperando = clientesEsperando.filter(cliente => cliente.id !== id);
});
```

Esto limpia la lista si el navegador se cierra, si se cancela el request o si la conexion se pierde.

## 4. Envio de mensajes a conexiones pendientes

Archivo: `server.js`

### Broadcast

```js
const difundirATodos = (mensaje, rpcType) => {
    mensaje.tipo = rpcType;
    clientesEsperando.forEach(cliente => cliente.callback(mensaje));
    clientesEsperando = [];
    return { status: `${rpcType.replace('[', '').replace(']', '').toLowerCase()} enviado` };
};

const enviarBroadcast = (mensaje) => difundirATodos(mensaje, "[BROADCAST]");
```

Aqui el servidor responde a todos los clientes que estaban esperando en `Poll`.
Cada `cliente.callback(mensaje)` completa una llamada gRPC pendiente.

En otras palabras: no se envia por un WebSocket permanente, sino respondiendo las peticiones gRPC que estaban abiertas.

### Multicast

```js
const enviarMulticast = (mensaje) => {
    mensaje.tipo = "[MULTICAST]";
    const destinatarios = clientesEsperando.filter(c => c.sala === mensaje.sala);
    destinatarios.forEach(cliente => cliente.callback(mensaje));
    clientesEsperando = clientesEsperando.filter(c => c.sala !== mensaje.sala);
    return { status: 'Multicast enviado a la sala ' + mensaje.sala };
};
```

Aqui solo se responde a los clientes que estan escuchando la misma sala.

La seleccion ocurre con:

```js
clientesEsperando.filter(c => c.sala === mensaje.sala)
```

Despues de responderles, se eliminan de la cola porque su llamada `Poll` ya termino.

### Anycast

```js
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
```

Anycast entrega el mensaje solo al primer cliente disponible en la sala.

La parte clave es:

```js
const indice = clientesEsperando.findIndex(c => c.sala === salaDestino);
```

Luego se responde solo a ese cliente:

```js
cliente.callback(mensaje);
clientesEsperando.splice(indice, 1);
```

## 5. Gateway HTTP conectado al servidor gRPC

Archivo: `gateway.js`

```js
const GRPC_SERVER = process.env.GRPC_SERVER || '127.0.0.1:50051';
const client = new mensajeriaProto.Mensajeria(GRPC_SERVER, grpc.credentials.createInsecure());
```

Aqui el gateway crea un cliente gRPC apuntando al servidor en `127.0.0.1:50051`.

Ese cliente es quien abre la comunicacion hacia el backend gRPC. Internamente usa sockets TCP/HTTP2.

```js
const client = new mensajeriaProto.Mensajeria(
    GRPC_SERVER,
    grpc.credentials.createInsecure()
);
```

`createInsecure()` indica que la conexion no usa TLS. Para una practica local esta bien, pero en produccion se usarian credenciales seguras.

## 6. Gateway HTTP escuchando al navegador

Archivo: `gateway.js`

```js
const PORT = 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`API Gateway Iniciado en el puerto ${PORT}`);
    console.log(`Abierto a Navegadores (Frontend HTML) en el puerto ${PORT}`);
    console.log(`Usando el Backend gRPC en ${GRPC_SERVER}`);
});
```

Aqui Express abre el puerto `3000`.
Este es el socket HTTP que usa el navegador cuando entra a:

```text
http://localhost:3000
```

El navegador no se conecta directamente a gRPC.
Primero habla con Express por HTTP, y Express traduce esas peticiones a llamadas gRPC.

## 7. Long polling HTTP desde el navegador

Archivo: `public/index.html`

```js
async function iniciarPolling(salaAescuchar, tipo_sala = 'unicast') {
    if (salasEscuchando.has(salaAescuchar)) return;
    salasEscuchando.add(salaAescuchar);

    const pollLoop = async () => {
        try {
            const response = await fetch(`/poll/${encodeURIComponent(salaAescuchar)}?tipo=${tipo_sala}`);

            if (response.status === 200) {
                const mensaje = await response.json();
                if (!mensajesVistos.has(mensaje.id)) {
                    mensajesVistos.add(mensaje.id);
                    procesarMensajeEntrante(mensaje);
                }
            }
        } catch (error) {
            console.error(`Conexion perdida con la sala ${salaAescuchar}...`, error);
        } finally {
            setTimeout(pollLoop, 1000);
        }
    };

    pollLoop();
}
```

El navegador hace una peticion HTTP al gateway:

```js
fetch(`/poll/${encodeURIComponent(salaAescuchar)}?tipo=${tipo_sala}`)
```

Esa peticion queda esperando hasta que el backend gRPC tenga un mensaje.
Cuando llega respuesta, el frontend procesa el mensaje y vuelve a llamar a `pollLoop`.

Esto simula una comunicacion en tiempo real sin usar WebSockets.

## 8. Traduccion de HTTP a gRPC en el gateway

Archivo: `gateway.js`

```js
app.get('/poll/:sala', (req, res) => {
    const sala = req.params.sala;
    const tipo_sala = req.query.tipo || 'unicast';

    const call = client.Poll({ sala: sala, tipo_sala: tipo_sala }, (error, response) => {
        if (error) {
            if (error.code === grpc.status.CANCELLED) return res.end();
            if (!res.headersSent) {
                return res.status(502).json({ error: 'Error comunicandose con Backend gRPC.' });
            }
            return;
        }

        let data = { usuario: 'Anonimo', texto: '' };
        if (response.contenido) {
            try { data = JSON.parse(response.contenido); } catch (e) { data.texto = response.contenido; }
        }

        res.json({
            tipo: response.tipo,
            usuario: data.usuario,
            sala: response.sala,
            texto: data.texto,
            id: data.id,
            isUnicast: data.isUnicast
        });
    });

    req.on('close', () => {
        if (!res.writableEnded) {
            call.cancel();
        }
    });
});
```

Este bloque une los dos mundos:

- El navegador entra por HTTP con `GET /poll/:sala`.
- El gateway llama al backend con `client.Poll(...)`.
- Cuando gRPC responde, el gateway responde al navegador con JSON.

La parte que cancela la conexion es importante:

```js
req.on('close', () => {
    if (!res.writableEnded) {
        call.cancel();
    }
});
```

Si el usuario cierra la pestaña o se corta la peticion HTTP, el gateway cancela tambien la llamada gRPC.

## 9. Envio desde el navegador hacia gRPC

Archivo: `gateway.js`

```js
app.post('/enviar/:metodo', (req, res) => {
    const metodo = req.params.metodo;
    const payload = {
        sala: req.body.sala,
        contenido: JSON.stringify(req.body)
    };

    const handler = (error, response) => {
        if (error) {
            return res.status(error.code === grpc.status.NOT_FOUND ? 404 : 500).json({ error: error.details });
        }
        res.status(200).json({ status: response.status });
    };

    if (metodo === 'broadcast') {
        client.EnviarBroadcast({ contenido: payload.contenido }, handler);
    } else if (metodo === 'multicast') {
        client.EnviarMulticast(payload, handler);
    } else if (metodo === 'anycast') {
        client.EnviarAnycast(payload, handler);
    } else {
        res.status(400).json({ error: 'Metodo no valido' });
    }
});
```

Aqui el navegador manda un `POST` normal al gateway.
El gateway decide que metodo gRPC ejecutar:

```js
client.EnviarBroadcast(...)
client.EnviarMulticast(...)
client.EnviarAnycast(...)
```

Cada llamada viaja desde `gateway.js` hacia `server.js` usando gRPC sobre sockets TCP.

## 10. Cliente gRPC puro desde terminal

Archivo: `cliente.js`

```js
const GRPC_SERVER = process.env.GRPC_SERVER || '127.0.0.1:50051';
const client = new mensajeriaProto.Mensajeria(GRPC_SERVER, grpc.credentials.createInsecure());
```

Este cliente no usa navegador ni gateway.
Se conecta directamente al servidor gRPC en el puerto `50051`.

```js
function escucharMensajes() {
    client.Poll({ sala: "Sistemas" }, (error, response) => {
        if (!error) {
            let data = {};
            try { data = JSON.parse(response.contenido); } catch(e) { data.texto = response.contenido; }

            console.log(`[NUEVO MENSAJE] Tipo: ${response.tipo} | Sala: ${response.sala}`);
            console.log(`Usuario: ${data.usuario || 'Anonimo'} -> "${data.texto || ''}"`);
        } else {
            console.error("Error al escuchar:", error.message);
        }

        escucharMensajes();
    });
}
```

La funcion `escucharMensajes` hace una llamada `Poll`.
Cuando recibe respuesta, se vuelve a llamar a si misma:

```js
escucharMensajes();
```

Esto crea un ciclo continuo de escucha basado en llamadas gRPC sucesivas.

## Conclusion

El proyecto usa sockets de forma indirecta:

- `server.js` abre un servidor gRPC en el puerto `50051`.
- `gateway.js` abre un servidor HTTP en el puerto `3000`.
- `gateway.js` tambien crea un cliente gRPC hacia `127.0.0.1:50051`.
- `public/index.html` usa `fetch` para mantener long polling contra el gateway.
- `cliente.js` se conecta directamente al servidor gRPC sin pasar por el navegador.

No hay WebSockets en este codigo.
La comunicacion en tiempo real se logra con long polling HTTP/gRPC y conexiones TCP administradas por Express y gRPC.
