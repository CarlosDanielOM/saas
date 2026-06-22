// Mobile uses the same DimaFX runtime as the desktop panel.
// Keep this file in sync by loading the panel runtime when mobile boots.
const script = document.createElement("script");
script.src = "panel.js?v=36";
document.currentScript?.after(script);
