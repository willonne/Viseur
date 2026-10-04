const cameraButton = document.querySelector("#camera-button");
const cameraMessage = document.querySelector("#camera-message");
const cameraPlaceholder = document.querySelector("#camera-placeholder");
const localVideo = document.querySelector("#local-video");
const micButton = document.querySelector("#mic-button");
const stopButton = document.querySelector("#stop-button");
const reportButton = document.querySelector("#report-button");

let cameraStream = null;
let microphoneStream = null;

cameraButton.addEventListener("click", async () => {
  cameraButton.disabled = true;
  cameraMessage.textContent = "Demande d’accès à la caméra…";

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
    localVideo.srcObject = cameraStream;
    localVideo.hidden = false;
    cameraPlaceholder.hidden = true;
  } catch (error) {
    cameraMessage.textContent =
      error.name === "NotAllowedError"
        ? "Accès refusé. Autorise la caméra dans le navigateur."
        : "Impossible d’ouvrir la caméra.";
  } finally {
    cameraButton.disabled = false;
  }
});

micButton.addEventListener("click", async () => {
  if (microphoneStream) {
    const track = microphoneStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    micButton.textContent = track.enabled
      ? "Couper le micro"
      : "Réactiver le micro";
    return;
  }

  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: true,
    });
    micButton.textContent = "Couper le micro";
  } catch {
    micButton.textContent = "Micro indisponible";
  }
});

stopButton.addEventListener("click", () => {
  for (const stream of [cameraStream, microphoneStream]) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  cameraStream = null;
  microphoneStream = null;
  localVideo.srcObject = null;
  localVideo.hidden = true;
  cameraPlaceholder.hidden = false;
  cameraMessage.textContent = "Votre aperçu vidéo apparaîtra ici";
  micButton.textContent = "Activer le micro";
});

reportButton.addEventListener("click", () => {
  window.alert(
    "Cette démo n’envoie ni n’enregistre de signalement."
  );
});
