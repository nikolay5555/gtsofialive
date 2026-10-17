/*
 * Optional WebSocket availability notice.
 * Set WEBSOCKET_NOTICE_ENABLED to false to hide it without removing any markup.
 * This notice is intentionally manual; it does not change or monitor the WebSocket connection.
 */
(() => {
  'use strict';

  const WEBSOCKET_NOTICE_ENABLED = true;
  if (!WEBSOCKET_NOTICE_ENABLED) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'websocket-notice-backdrop';
  backdrop.innerHTML = `
    <section class="websocket-notice-dialog" role="dialog" aria-modal="true"
      aria-labelledby="websocket-notice-title" aria-describedby="websocket-notice-message">
      <button class="websocket-notice-x" type="button" aria-label="Затвори съобщението">&times;</button>
      <div class="websocket-notice-icon" aria-hidden="true">!</div>
      <p class="websocket-notice-eyebrow">GTSOFIA · ИНФОРМАЦИЯ</p>
      <h2 id="websocket-notice-title">Временен проблем с живите данни</h2>
      <p id="websocket-notice-message" class="websocket-notice-message">
        В момента има временен проблем с WebSocket сървъра и превозните средства може да не се показват на картата.
        Извиняваме се за причиненото неудобство.
      </p>
      <button class="websocket-notice-close" type="button">Затвори</button>
    </section>
  `;

  document.body.appendChild(backdrop);

  const closeNotice = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKeyDown);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') closeNotice();
  };

  backdrop.querySelectorAll('.websocket-notice-x, .websocket-notice-close')
    .forEach((button) => button.addEventListener('click', closeNotice));
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeNotice();
  });
  document.addEventListener('keydown', onKeyDown);
})();
