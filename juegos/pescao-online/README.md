# 🐟 Pescao Online — 4 a 10 jugadores

Un juego web gratuito, **no oficial**, de preguntas, mentiras y deducción para teléfonos. Inspirado en la mecánica social de encontrar respuestas falsas de juegos como *Chao Pescao / Sounds Fishy*. El diseño, la implementación y las **100 preguntas** de este repositorio son originales. No está afiliado con Big Potato Games ni Mercurio.

## Cómo jugar

1. Un jugador abre la web desde su teléfono, escribe su nombre y pulsa **Crear una sala**. Se genera un código de seis caracteres y un enlace para compartir.
2. Entre **3 y 9 amigos** abren el enlace y escriben sus nombres (4–10 jugadores en total). La persona anfitriona pulsa **Empezar partida**.
3. Cada ronda tiene un **pescador**, un **pez azul** y peces **rojos**. Todos ven la pregunta; sólo el pez azul recibe la respuesta verdadera. Los rojos escriben mentiras en sus teléfonos.
4. Al terminar los 90 segundos o recibir todas las respuestas, el pescador ve las respuestas asociadas con sus autores. Debe tocar a los jugadores que cree que mienten. Cada rojo atrapado suma 1 punto **provisional**. Si atrapa al azul, pierde lo provisional. Puede plantarse para guardar lo acumulado. Atrapar a todos los rojos concede +1 punto extra.
5. Los peces rojos no atrapados ganan 1 punto por cada pez revelado, incluido el azul. El pez azul gana un punto por cada pez que queda sin revelar **si fue atrapado**. Si son 4 o 5 participantes, cada persona pesca dos veces; si son de 6 a 10, pesca una vez. Gana quien sume más puntos.

## Funciones incluidas

- Sala privada por código/link; 4 a 10 participantes; responsive para móvil y computadora.
- Preguntas originales en español, 100 cartas sin repetición hasta agotar el mazo.
- Reparto secreto de papeles; el pescador no ve la verdad ni quién es el azul.
- Validaciones de turnos y acciones; las puntuaciones se calculan en el dispositivo anfitrión.
- Reconexión con el mismo nombre, puntuación y rol al volver al navegador.
- Recuperación de sala por el anfitrión después de recargar la página (estado guardado en su navegador).
- Temporizador de 90 segundos, cierre anticipado, salto de ronda excepcional, marcador y revancha.
- Enlace para invitar, copiar código, instalación como acceso directo web (manifest).

## Tecnología / funcionamiento en línea

GitHub Pages sólo aloja archivos estáticos: **no provee un servidor de partidas**. Por eso la versión publicada usa [PeerJS](https://peerjs.com/), WebRTC y el servicio gratuito **PeerServer Cloud**, con **topología de estrella**: el teléfono anfitrión mantiene el estado y envía cambios a los otros nueve teléfonos.

No se requiere instalar nada ni crear una cuenta para jugar; sí se requiere internet para todos. Hay algunas limitaciones importantes:

- El anfitrión **debe mantener la página abierta y su teléfono activo**. Si la cierra, la partida queda temporalmente inaccesible hasta que la recupere en el mismo navegador.
- El servidor público PeerJS sólo establece conexiones. Puede tener interrupciones, límites o bloqueos en ciertas redes móviles/NAT; sin servidor TURN propio no se garantiza conexión entre todos los operadores. **No constituye infraestructura de producción con disponibilidad garantizada.**
- El juego **no incluye videollamada ni chat de voz**. Se puede jugar sólo con las respuestas escritas; para bromear en vivo pueden usar una llamada paralela.
- El mazo está en JavaScript del sitio: el juego evita revelar la respuesta en la interfaz del pescador, pero no impide que alguien inspeccione el código fuente para hacer trampa.
- Las salas no tienen contraseñas ni cifrado de extremo a extremo adicional; WebRTC cifra el transporte. No compartas información sensible en nombres o respuestas.
- Para un producto comercial escalable conviene reemplazar el transporte PeerJS por un backend con WebSockets y base de datos, por ejemplo Node + Redis o Supabase Realtime, y usar señalización/TURN propios.

## Desarrollo y pruebas

No se necesitan dependencias para la lógica. Se requiere **Node.js 20+** para las pruebas:

```bash
node --test tests/*.test.mjs
```

Para verlo localmente:

```bash
python -m http.server 8000
```

Abre http://localhost:8000/; para jugar con teléfonos de distintas redes publica la carpeta en un dominio HTTPS. La librería PeerJS se carga por CDN (jsDelivr con alternativa unpkg). El servidor que señaliza las conexiones es `0.peerjs.com`.

## Publicación

El contenido de esta carpeta puede colocarse en la raíz de un repositorio nuevo con GitHub Pages habilitado o dentro de una subcarpeta de un proyecto existente que despliegue todos sus archivos. Todas las rutas de recursos son relativas, así que funciona desde un subdirectorio.

## Derechos

Implementación y preguntas creadas como material independiente para este proyecto. No se incluyen textos de tarjetas, imágenes, logos, manuales ni recursos gráficos del juego comercial. `Pescao Online` no se presenta como producto oficial.