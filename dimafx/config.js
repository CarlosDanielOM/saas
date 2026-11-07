// DimaFX broadcaster config view. Kept out of config.html because Twitch's CSP blocks inline scripts.
const STRINGS = {
  en: {
    title: "Let viewers play your sounds, clips and voice messages on stream",
    intro: "Viewers use Bits in this panel and their pick plays on your stream. You set everything up on DomDimaBot.",
    step1: "Pick your items", step1note: "Choose media from your library and how many Bits each one takes.",
    step2: "Add the overlay to OBS", step2note: "Copy the DimaFX browser-source link from the same page. Viewers can only use items while it's open.",
    step3: "Go live", step3note: "The panel shows \"On stream\" when items can play.",
    waiting: "Waiting for Twitch…", ready: "Connected to your channel.",
    cta: "Set up DimaFX on DomDimaBot", external: "Opens domdimabot.com in a new tab.",
  },
  es: {
    title: "Deja que tus espectadores reproduzcan tus sonidos, clips y mensajes de voz en el stream",
    intro: "Tus espectadores usan Bits en este panel y lo que eligen se reproduce en tu stream. Todo se configura en DomDimaBot.",
    step1: "Elige tus artículos", step1note: "Escoge media de tu biblioteca y cuántos Bits usa cada uno.",
    step2: "Agrega el overlay a OBS", step2note: "Copia el enlace de fuente de navegador de DimaFX en la misma página. Los espectadores solo pueden usar artículos mientras esté abierto.",
    step3: "Transmite en vivo", step3note: "El panel muestra \"En el stream\" cuando los artículos se pueden reproducir.",
    waiting: "Esperando a Twitch…", ready: "Conectado a tu canal.",
    cta: "Configurar DimaFX en DomDimaBot", external: "Abre domdimabot.com en una pestaña nueva.",
  },
};
const params = new URLSearchParams(location.search);
const lang = (params.get("language") || navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
const t = (key) => STRINGS[lang][key];
document.documentElement.lang = lang;
document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });

let channelId = "";
if (window.Twitch) {
  Twitch.ext.onAuthorized((auth) => {
    channelId = auth.channelId || "";
    document.getElementById("status").textContent = t("ready");
  });
  Twitch.ext.onContext?.((context) => {
    document.documentElement.classList.toggle("dark", context?.theme !== "light");
  });
}
// The site opens the DimaFX page directly when the streamer is signed in there, and asks them to log in otherwise.
document.getElementById("configure-btn").addEventListener("click", () => {
  const url = channelId ? "https://domdimabot.com/" + encodeURIComponent(channelId) + "/modules/dimafx" : "https://domdimabot.com/login";
  window.open(url, "_blank", "noopener,noreferrer");
});
