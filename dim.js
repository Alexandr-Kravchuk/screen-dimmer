let state = { opacity: 0.6 };

function apply(s) {
  state = { ...state, ...s };
  document.documentElement.style.setProperty('--dim', String(state.opacity));
}

window.dimmer.onApply(apply);
window.dimmer.getState().then(apply);
