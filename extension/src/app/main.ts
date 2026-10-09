// The host app's page (MCPSafari/Resources/Base.lproj/Main.html). Swift calls
// `show(...)` by name through `evaluateJavaScript`, so it has to stay a global.

declare global {
  interface Window {
    show: typeof show;
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

function enableNativeInput(): void {
  webkit.messageHandlers.controller.postMessage("enable-native-input");
}

window.show = show;

document.querySelector("button.open-preferences")?.addEventListener("click", openPreferences);

document.querySelector("button.enable-native-input")?.addEventListener("click", enableNativeInput);

export {};
