# Arquitectura y Tecnologías del Proyecto RPC Chat

Este documento detalla la estructura tecnológica del sistema de mensajería, desglosando cada capa y justificando el uso de RPC (Remote Procedure Call) frente a sockets tradicionales.

## 1. Arquitectura del Sistema

El proyecto sigue un modelo de *Microservicios* balanceado por un *API Gateway*. La comunicación fluye en cascada:

mermaid
graph TD
    A[Frontend: Navegador] -->|HTTP 1.1 / JSON| B(API Gateway: Node.js + Express)
    B -->|gRPC / Protocol Buffers| C(Backend Server: Node.js + gRPC)
    C -.->|Respuesta asíncrona| B
    B -.->|Long Polling| A


### Capa de Frontend (Cliente)
*   *Tecnologías:* HTML5, CSS3 (Vanilla) y JavaScript (Vanilla/ES6).
*   *Interfaz:* Diseño responsivo que imita la estética de WhatsApp.
*   *Comunicación:* Utiliza la *Fetch API* para realizar peticiones HTTP al Gateway.
    *   *Envío:* Peticiones POST con cuerpos en formato JSON.
    *   *Recepción:* Implementa *Long Polling*, una técnica donde el cliente hace una petición GET y el servidor la mantiene abierta hasta que hay un mensaje nuevo, simulando tiempo real sin usar WebSockets directos.

### Capa de API Gateway (Intermediario)
*   *Tecnologías:* Node.js + Express.
*   *Función:* Actúa como un traductor de protocolos. Recibe tráfico web estándar (HTTP/JSON) y lo convierte en llamadas de alta eficiencia (gRPC/Protobuf) para el servidor de backend. 
*   *Seguridad y Abstracción:* Al usar un Gateway, el backend real (puerto 50051) nunca está expuesto directamente al mundo exterior, solo el puerto 3000.

### Capa de Backend (Servidor de Mensajería)
*   *Tecnologías:* Node.js + @grpc/grpc-js.
*   *Lógica:* Maneja la distribución de mensajes mediante tres algoritmos:
    1.  *Broadcast:* Envío a todos los conectados.
    2.  *Multicast:* Envío filtrado por "Sala" o grupo.
    3.  *Anycast:* Envío al primer cliente disponible en una sala específica (balanceo de carga básico).

---

## 2. RPC vs. Sockets desde Cero (Justificación)

Una duda común es: ¿Por qué usar gRPC (o herramientas como rpcgen) si podríamos crear sockets TCP/UDP manualmente?

### El problema de los Sockets "Desde Cero"
Cuando trabajas con sockets puros (net en Node.js o socket.h en C):
1.  *Manejo de Flujos (Streaming):* Tienes que decidir cómo separar un mensaje de otro (fragmentación). ¿Usas un carácter especial como \n? ¿Envías primero el tamaño del mensaje en 4 bytes? Tú debes programar esa lógica.
2.  *Serialización:* Tienes que convertir tus objetos (ej. {usuario: "Pepe", texto: "Hola"}) a una cadena de texto o binario y viceversa en el otro extremo. Si el cliente está en C y el servidor en Node, la compatibilidad es difícil.
3.  *Mantenimiento:* Si agregas un nuevo campo (ej. "fecha"), debes actualizar manualmente el código de empaquetado y desempaquetado en todas partes del sistema.

### La solución con RPC (gRPC / Protobuf)
Al usar gRPC y un archivo de definición (.proto), el desarrollo cambia radicalmente:

*   *Tipado Fuerte:* El archivo .proto actúa como un "contrato". Si el mensaje no cumple con la estructura definida, la llamada falla automáticamente. No hay errores de "campo indefinido".
*   *Abstracción de Red:* Para el programador, enviar un mensaje gRPC se siente como ejecutar una función local: client.EnviarBroadcast(payload). *No parece red*, parece código normal.
*   *Serialización Binaria Automática:* Protocol Buffers convierte tus datos a binario de forma extremadamente eficiente (mucho más rápido y ligero que JSON), reduciendo el consumo de ancho de banda.
*   *Independencia de Lenguaje:* Podrías escribir el servidor en Go y el cliente en Python; ambos generarían su código automáticamente a partir del mismo archivo .proto y se entenderían perfectamente.

*En conclusión:* Usar RPC permite a los desarrolladores centrarse en la *lógica del negocio* (cómo enviar mensajes) en lugar de pelear con los *detalles de la red* (cómo leer bytes de un buffer o manejar reconexiones TCP).