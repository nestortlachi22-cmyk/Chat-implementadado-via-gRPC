# Análisis de Conexiones en la Arquitectura RPC y HTTP

A continuación se explican a fondo cómo operan las conexiones, el uso de puertos, cómo ocurre la comunicación en una red local entre equipos (como tu computadora y una Raspberry Pi), y la elección del protocolo de base.

## 1. Las Conexiones y el Uso de Puertos

La arquitectura está diseñada en base a dos componentes que operan comunicándose entre ellos.
*   **El API Gateway (`gateway.js`):** Emplea el puerto TCP **`3000`** mediante el framework Express. Este puerto expone el servidor web hacia afuera. Es el "recepcionista" de tu sistema.
*   **El Servidor gRPC (`server.js`):** Emplea el puerto TCP **`50051`**. Reside en segundo plano y contiene la lógica de mensajería general.

El API Gateway es a su vez un cliente del servidor gRPC. El Gateway recibe peticiones HTTP en el puerto 3000, y para resolverlas se "da la vuelta" y le habla a `server.js` usando gRPC a través del puerto 50051 (específicamente por la dirección `localhost:50051`).

## 2. Acceso desde otro dispositivo (La Raspberry Pi)

Si desde un dispositivo ajeno a tu computadora (como una Raspberry Pi) abres un navegador web e ingresas a la IP de la computadora usando el puerto 3000 (por ejemplo, `http://192.168.x.x:3000`), el sistema es accesible y funciona. 

Esto funciona y está justificado por la siguiente línea clave en tu código de `gateway.js`:
```javascript
app.listen(PORT, '0.0.0.0', () => { ... });
```
*   **La máscara '0.0.0.0':** En el mundo de redes, al asignarle a una aplicación la tarea de escuchar sobre la IP `0.0.0.0`, se le está instruyendo escuchar en **todas las interfaces de red disponibles** que posee el sistema operativo anfitrión. 
*   Si hubieses escrito `'127.0.0.1'` o `'localhost'`, el Gateway habría rechazado silenciosamente conexiones buscando acceder desde fuera (es decir, desde el Wi-Fi o Ethernet). Al poner `0.0.0.0`, Express.js está aceptando la conexión que viaja a través del router desde tu Raspberry Pi hasta la tarjeta de red de tu computadora principal.

## 3. Justificación del Paso de Mensajes y Canales Virtuales

La comunicación se conforma en **dos canales o puentes distintos**:

1.  **Canal Cliente-Gateway (sobre HTTP 1.1):**
    Tu Raspberry Pi y la vista del frontend (en HTML/JS) asumen un modelo de comunicación basado en **Petición y Respuesta**.
    El paso de mensajes se da usando verbos clásicos de REST HTTP (`GET` y `POST`). Específicamente, el navegador deja una petición HTTP `GET` "colgada" o en espera a que le llegue un mensaje (`Long Polling`) que golpea internamente tu ruta `app.get('/poll/:sala')` del API Gateway. Cuando el Gateway envía un contenido de vuelta, cierra la respuesta y el HTML reabre el canal virtual haciendo otra petición.

2.  **Canal Virtual Gateway-Servidor (sobre gRPC y HTTP/2):**
    Una vez que el Gateway recibe el mensaje físico en JSON mediante un POST (de tu Raspberry Pi), crea un **Canal Virtual de Comunicación** enviando el dato mediante métodos propios como `client.EnviarBroadcast(...)`.
    ¿Por qué llamarlo "canal virtual"? Porque gRPC construye por debajo de nuestra vista una conexión persistente altamente rápida basada en el protocolo HTTP/2 usando serialización de objetos (Protocol Buffers - `mensajeria.proto`). Actúa virtualmente como si el Gateway pudiera ejecutar directamente código que "vive" y le pertenece al `server.js`.

## 4. Por qué los Sockets se crean en TCP y no en UDP

Tanto la capa HTTP de Express para atender tu Raspberry Pi, como la capa oculta gRPC que une tu Gateway y Servidor, basan todos sus sockets subyacentes sobre el protocolo **TCP (Transmission Control Protocol)** y **no sobre UDP**. 

Esto está estrictamente justificado por la necesidad fundamental de la de la plataforma que estás construyendo: **Intercambio seguro de mensajes chat**.

*   **TCP es Confiable (Orientado a la conexión):** Antes de enviar un solo caracter de texto, el servidor TCP y el cliente hacen un saludo inicial (_Three-way handshake_) acordando el estado de la comunicación. TCP se cerciora de que todo lo que enviemos llegue. Si un segmento del mensaje del cliente colisiona o se pierde por interferencia de Wi-Fi, el protocolo TCP lo nota y **lo retransmite forzosamente**.
*   **TCP Garantiza el Orden:** En TCP los datos llegan del mismo modo que se ensamblaron. Si esto fuera un flujo de video a 60 FPS, usaríamos UDP porque no importa si se pierde un fotograma con tal de mantener velocidad, pero en un mensaje de texto no hay tolerancia para recibir letras o palabras en un orden incorrecto.
*   **UDP (User Datagram Protocol) hace fallar el concepto:** Si se hubieran usado sockets UDP, tu aplicación sería propensa a pérdidas. UDP manda la data de la Raspberry Pi a la Servidora a ciegas (_Fire and Forget_ - disparar y olvidar). No retiene estado virtual ni se preocuparía si el receptor no acuso de recibo. En un flujo RPC donde debes tener la certeza de recibir código de error real o ver si todos en una sala recibieron el texto (tu método Anycast/Multicast, etc), se necesita obligatoriamente una comunicación TCP.
