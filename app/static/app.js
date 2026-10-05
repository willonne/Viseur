const cameraButton = document.querySelector("#camera-button");
const cameraMessage = document.querySelector("#camera-message");
const cameraPlaceholder = document.querySelector("#camera-placeholder");
const localVideo = document.querySelector("#local-video");
const remoteVideo = document.querySelector("#remote-video");
const micButton = document.querySelector("#mic-button");
const stopButton = document.querySelector("#stop-button");
const reportButton = document.querySelector("#report-button");
const matchButton = document.querySelector("#match-button");
const matchStatus = document.querySelector("#match-status");

let cameraStream = null;
let microphoneStream = null;
let matchSocket = null;
let currentSessionId = null;
let peerConnection = null;
const pendingSignals = [];
const signalTypes = new Set(["offer", "answer", "ice"]);

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
        ? "Accès refusé. Autorise la caméra dans les réglages du navigateur."
        : "Impossible d’ouvrir la caméra. Vérifie qu’elle est disponible.";
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
  if (matchSocket) {
    matchSocket.close();
    matchSocket = null;
    matchButton.disabled = false;
    matchButton.textContent = "Chercher une rencontre";
    matchStatus.textContent = "Rencontre arrêtée.";
  }
  currentSessionId = null;
  window.viseurSignaling.detachPeerConnection();
  pendingSignals.length = 0;
  remoteVideo.srcObject = null;
  remoteVideo.hidden = true;
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

reportButton.addEventListener("click", async () => {
  const reason = window.prompt(
    "Motif :\n1 = harcèlement\n2 = contenu sexuel non sollicité\n3 = personne potentiellement mineure\n4 = autre"
  );

  const reasons = {
    "1": "harassment",
    "2": "sexual_content",
    "3": "suspected_minor",
    "4": "other",
  };

  if (!reasons[reason]) return;

  const description = window.prompt(
    "Décris brièvement le problème (10 à 1000 caractères)."
  );

  if (!description || description.trim().length < 10) {
    window.alert("La description doit contenir au moins 10 caractères.");
    return;
  }

  try {
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: reasons[reason],
        description: description.trim(),
      }),
    });

    if (!response.ok) throw new Error("Envoi impossible");

    const result = await response.json();
    window.alert(`Signalement enregistré. Référence : ${result.report_id}`);
  } catch {
    window.alert("Impossible d’envoyer le signalement. Vérifie le serveur.");
  }
});

async function startPeerConnection(initiator) {
  if (!cameraStream || !microphoneStream) {
    throw new Error("Active la caméra et le micro avant de chercher.");
  }

  const connection = new RTCPeerConnection({
    iceServers: [],
    iceTransportPolicy: "all",
  });

  const outgoingStream = new MediaStream([
    ...cameraStream.getVideoTracks(),
    ...microphoneStream.getAudioTracks(),
  ]);

  for (const track of outgoingStream.getTracks()) {
    connection.addTrack(track, outgoingStream);
  }

  connection.addEventListener("track", (event) => {
    if (event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.hidden = false;
    }
  });

  connection.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      window.viseurSignaling.send("ice", event.candidate.toJSON());
    }
  });

  connection.addEventListener("connectionstatechange", () => {
    if (connection.connectionState === "connected") {
      matchStatus.textContent = "Appel vidéo connecté.";
    } else if (connection.connectionState === "failed") {
      matchStatus.textContent =
        "Connexion vidéo impossible. Un relais TURN sera nécessaire.";
    }
  });

  await window.viseurSignaling.attachPeerConnection(connection);

  if (initiator) {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    window.viseurSignaling.send("offer", connection.localDescription.toJSON());
  } else {
    matchStatus.textContent = "Partenaire associé ; connexion vidéo en cours…";
  }
}
async function processSignal(message) {
  if (!peerConnection) {
    pendingSignals.push(message);
    matchStatus.textContent =
      "Message WebRTC reçu ; configuration de l’appel en attente.";
    return;
  }

  if (message.type === "ice" && !peerConnection.remoteDescription) {
    pendingSignals.push(message);
    return;
  }

  if (message.type === "offer") {
    await peerConnection.setRemoteDescription(message.payload);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    window.viseurSignaling.send(
      "answer",
      peerConnection.localDescription.toJSON()
    );

    const queued = pendingSignals.splice(0);
    for (const queuedMessage of queued) {
      await processSignal(queuedMessage);
    }
  } else if (message.type === "answer") {
    await peerConnection.setRemoteDescription(message.payload);

    const queued = pendingSignals.splice(0);
    for (const queuedMessage of queued) {
      await processSignal(queuedMessage);
    }
  } else if (message.type === "ice") {
    await peerConnection.addIceCandidate(message.payload);
  }
}
window.viseurSignaling = {
  send(type, payload) {
    if (!signalTypes.has(type)) {
      throw new Error("Type de signalisation inconnu.");
    }
    if (!matchSocket || matchSocket.readyState !== WebSocket.OPEN) {
      throw new Error("Aucune connexion de mise en relation active.");
    }
    if (!currentSessionId) {
      throw new Error("Aucune session active.");
    }

    matchSocket.send(JSON.stringify({ type, payload }));
  },

  async attachPeerConnection(connection) {
    peerConnection = connection;
    const queued = pendingSignals.splice(0);

    for (const message of queued) {
      await processSignal(message);
    }
  },

  detachPeerConnection() {
    peerConnection?.close();
    peerConnection = null;
  },
};

matchButton.addEventListener("click", () => {
  if (matchSocket) {
    window.viseurSignaling.detachPeerConnection();
    pendingSignals.length = 0;
    remoteVideo.srcObject = null;
    remoteVideo.hidden = true;
    matchSocket.close();
    matchSocket = null;
    currentSessionId = null;
    matchButton.textContent = "Chercher une rencontre";
    matchStatus.textContent = "Recherche arrêtée.";
    return;
  }

  if (!cameraStream || !microphoneStream) {
    matchStatus.textContent =
      "Active la caméra et le micro avant de chercher une rencontre.";
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws/match`);
  matchSocket = socket;
  matchButton.disabled = true;
  matchStatus.textContent = "Connexion au serveur…";

  socket.addEventListener("open", () => {
    matchButton.disabled = false;
    matchButton.textContent = "Annuler la recherche";
    matchStatus.textContent = "En attente d’une autre personne…";
  });

  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);

    if (message.session_id) currentSessionId = message.session_id;
      matchButton.textContent = "Annuler la recherche";
    if (message.type === "waiting") {
      matchStatus.textContent = "En attente d’une autre personne…";
    } else if (message.type === "matched") {     
      matchButton.textContent = "Quitter la conversation";
      try {
        await startPeerConnection(message.initiator);
      } catch (error) {
        matchStatus.textContent = error.message;
      }
    } else if (message.type === "partner_disconnected") {
      window.viseurSignaling.detachPeerConnection();
      remoteVideo.srcObject = null;
      remoteVideo.hidden = true;
      currentSessionId = null;
      matchStatus.textContent = "L’autre personne s’est déconnectée.";
    } else if (signalTypes.has(message.type)) {
      try {
        await processSignal(message);
      } catch {
        matchStatus.textContent = "Erreur lors du traitement du message WebRTC.";
      }
    } else if (message.type === "error") {
      matchStatus.textContent = message.message;
    }
  });

  socket.addEventListener("close", () => {
    if (matchSocket === socket) {
      matchSocket = null;
      currentSessionId = null;
      matchButton.disabled = false;
      matchButton.textContent = "Chercher une rencontre";
      matchStatus.textContent = "Recherche arrêtée.";
    }
  });

  socket.addEventListener("error", () => {
    matchStatus.textContent = "Connexion impossible. Vérifie le serveur.";
  });
});
