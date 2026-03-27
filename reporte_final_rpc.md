# Reporte Técnico: Arquitectura de Ruteo de Mensajes con Google RPC (gRPC)

Este documento detalla la implementación, decisiones arquitectónicas y el funcionamiento a bajo nivel de la práctica de chat conversacional utilizando el estándar Google RPC, cubriendo los niveles del modelo OSI involucrados.

---

## 1. ¿Cómo está funcionando RPC?
**RPC (Remote Procedure Call)** o **Llamada a Procedimiento Remoto**, es un protocolo de nivel de Sesión/Presentación (Capas 5 y 6 del modelo OSI) que permite a un programa de computadora ejecutar código en otra máquina de forma transparente. 

En este proyecto utilizamos la implementación moderna **gRPC** (desarrollada por Google). A diferencia de las APIs REST tradicionales que usan URLS y verbos (GET, POST), gRPC funciona **como si el servidor y el cliente fueran partes del mismo programa**. 

1. **El Contrato (`mensajeria.proto`):** Se definió un archivo Protobuf estricto que dicta qué funciones existen (ej. `EnviarBroadcast`) y cómo están tipados los datos.
2. **Serialización (Capa 6):** Cuando un cliente llama a `client.EnviarBroadcast(datos)`, gRPC no envía un archivo de texto JSON. Comprime los `datos` en lenguaje binario (Protobuf) haciendo el trasiego de red significativamente más rápido, pequeño y seguro.
3. **Transporte Binario:** El mensaje viaja usando internamente HTTP/2 puro (sobre TCP).
4. **Ejecución (Capa 7):** El servidor recibe el binario, lo decodifica a su lenguaje nativo (NodeJS), ejecuta su lógica y retorna la respuesta. Todo esto ocurre en milisegundos en modo **síncrono** (el cliente espera a la confirmación `response.status` para seguir).

---

## 2. ¿Por qué fue necesario el protocolo HTTP ("El Gateway")?
Si el proyecto entero es gRPC, ¿por qué utilizamos HTTP/JSON (Express) en el archivo `gateway.js`? 
La respuesta se conoce arquitectónicamente como **La restricción del Navegador**.

* **La Incompatibilidad:** Los navegadores web (Chrome, Firefox, Safari) **no tienen soporte nativo para enviar directamente tramas binarias crudas de HTTP/2** que exige el estándar gRPC puro. El navegador sabe hacer peticiones `fetch()` usando HTTP/1.1 que retornan texto (HTML, JS, XML, JSON).
* **La Solución (API Gateway):** Fue necesario crear un puente. Tu interfaz visual (`index.html`) hace peticiones web ordinarias a `gateway.js`. Entonces, `gateway.js` actúa como el **traductor**: lee tu texto en JSON, lo empaqueta en binario Protobuf, y se lo inyecta a tu servidor puro (`server.js`) a través de un canal exclusivo gRPC.
* **Conclusión:** HTTP solo fue necesario para la presentación gráfica de `HTML/CSS/JS` y la experiencia humana; pero el enrutamiento central y real de las interacciones ocurre enteramente por RPC.

---

## 3. Explicación a fondo: `server.js` (El Backend o Core)
`server.js` es tu motor de capa de red. No sabe qué es un navegador; es un servidor gRPC sordo y ciego a la web estándar. Sus responsabilidades son:

### A. Mantener un Estado Global
Utiliza el arreglo en memoria `let clientesEsperando = [];`. Cada vez que alguien invoca el RPC `Poll`, el servidor toma ese objeto de conexión abierta (`call`) y lo guarda allí asociándolo a una "Sala" determinada. De esta forma, el servidor conoce exactamente quiénes están "en línea" y en qué salas.

### B. Enrutamiento en Capa de Aplicación
El archivo implementa tres algoritmos matriciales para decidir hacia quién fluyen los datos (Capa OSI 7):
* **Broadcast:** Selecciona todo el arreglo de `clientesEsperando` y ejectuta `cliente.callback(mensaje)` para obligar a todos los "tubos" gRPC conectados a devolver los datos. Al final, vacía la cola porque todos han sido notificados.
* **Multicast:** Realiza un filtro (`.filter`) de la memoria revisando quién pertenece a la propiedad `salaDestino`. Solo aquellos que coinciden reciben la respuesta, ahorrando ancho de banda al resto.
* **Anycast:** A diferencia del multicast que envía a un subgrupo, éste busca con `.findIndex` al **primer nodo disponible** que pertenezca a la sala, entrega el paquete, y lo retira de la cola para liberar a ese cliente, dejando intactos a los demás. Se comporta como un asignador de tickets o Call-Center.

---

## 4. Explicación a fondo: `cliente.js` (Cliente gRPC Auténtico)
Para demostrar que el sistema gRPC funciona de maravilla sin navegadores (sin necesidad de HTTP/Express ni HTML), el archivo `cliente.js` es un script puro para máquinas.

### A. Simulación del Long-Polling (Client-Side)
En la función recursiva `escucharMensajes()`, el script invoca `client.Poll(...)`. Esta llamada unary de gRPC fue diseñada para **bloquearse intencionalmente** en el servidor hasta que alguien envíe un mensaje. En el momento en que gRPC responde, el cliente imprime el resultado en su terminal y **vuelve a llamarse a sí mismo** de inmediato para esperar el próximo mensaje. Así emula un flujo reactivo o "stream".

### B. Ejecución Transparente
En los bloques `setTimeout(..., 2000)`, observamos cómo el cliente dispara:
`client.EnviarBroadcast({ sala, contenido }, callback)`
Para el desarrollador, es como si llamara a la función en su computadora local. Toda la estandarización y encripción la realiza la librería gRPC generada dinámicamente (`protoLoader`). El servidor lo lee, lo ejecuta por su túnel y devuelve inmediatamente un estado de OK.
