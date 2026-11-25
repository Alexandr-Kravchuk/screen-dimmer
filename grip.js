const api = window.dimmer;

const el = document.getElementById('grip');
let start = null;

el.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  // keep receiving events even if the cursor leaves this tiny window
  el.setPointerCapture(e.pointerId);
  const r = await api.getRect();
  if (!r) return;
  start = { sx: e.screenX, sy: e.screenY, w: r.w, h: r.h };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
});

function onMove(e) {
  if (!start) return;
  api.resizeTo(start.w + (e.screenX - start.sx), start.h + (e.screenY - start.sy));
}

function onUp() {
  start = null;
  window.removeEventListener('pointermove', onMove);
}
