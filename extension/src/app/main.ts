// The host app's page (MCPSafari/Resources/Base.lproj/Main.html). Swift calls
// `show(...)` and `showPreferencesError(...)` by name through
// `evaluateJavaScript`, so they have to stay globals.

declare global {
  interface Window {
    show: typeof show;
    showPreferencesError: typeof showPreferencesError;
  }
}

// `enabled` true or false is Safari's answer; null means Safari would not give
// one, which is not the same as "not enabled" and must not be shown as it.
function show(enabled: boolean | null): void {
  document.body.classList.toggle(`state-on`, enabled === true);
  document.body.classList.toggle(`state-off`, enabled === false);
  document.body.classList.toggle(`state-error`, enabled === null);
}

function openPreferences(): void {
  webkit.messageHandlers.controller.postMessage("open-preferences");
}

// Safari can refuse to open its own settings pane, in which case nothing
// happens on screen and the button reads as broken. Say so instead.
function showPreferencesError(message: string): void {
  const note = document.querySelector<HTMLElement>(".preferences-note");

  if (note === null) return;

  note.textContent = `Safari would not open its settings: ${message} Open Safari > Settings > Extensions yourself.`;
  note.hidden = false;
}

function enableNativeInput(): void {
  webkit.messageHandlers.controller.postMessage("enable-native-input");
}

window.show = show;

window.showPreferencesError = showPreferencesError;

document.querySelector("button.open-preferences")?.addEventListener("click", openPreferences);

document.querySelector("button.enable-native-input")?.addEventListener("click", enableNativeInput);

export {};
