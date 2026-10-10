'use strict';

let localVideo = document.getElementById('localVideo');
let remoteVideo = document.getElementById('remoteVideo');
let peerConnection = null;
let peerConnectionPromise = null;
let iceCandidatesQueue = [];
let pendingSignals = [];
let pairedUserId = null;
let currentMatchId = null;
let userName = '';
let peerName = '';
let localStream = null;
let dataChannel = null;
let currentScreenTrack = null;
let incomingFile = null;
let isSearching = false;
let toastTimer = null;

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const FILE_CHUNK_SIZE = 16 * 1024;
const clientId = createClientId();
const events = new EventSource(`/events?clientId=${encodeURIComponent(clientId)}`);

const ui = {
    peerName: document.getElementById('peer-name-span'),
    localName: document.getElementById('local-user-name'),
    search: document.getElementById('search'),
    searchLabel: document.getElementById('search-label'),
    status: document.getElementById('connection-status'),
    statusText: document.getElementById('connection-status-text'),
    remoteEmpty: document.getElementById('remote-empty-state'),
    fullscreen: document.getElementById('fullscreen-remote'),
    mic: document.getElementById('toggle-mic'),
    camera: document.getElementById('toggle-camera'),
    messages: document.getElementById('messages'),
    chatMessage: document.getElementById('chat-message'),
    sendMessage: document.getElementById('send-message'),
    shareScreen: document.getElementById('share-screen'),
    transferFile: document.getElementById('transfer-file'),
    fileInput: document.getElementById('file-input'),
    transferProgress: document.getElementById('transfer-progress'),
    transferLabel: document.getElementById('transfer-progress-label'),
    transferBar: document.getElementById('transfer-progress-bar'),
    transferPercent: document.getElementById('transfer-progress-percent'),
    toast: document.getElementById('toast'),
    welcomeHint: document.getElementById('welcome-hint')
};

function createClientId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }
    return `client_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function api(path, payload = {}) {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    let body = {};
    try { body = await response.json(); } catch (_) {}

    if (!response.ok) {
        throw new Error(body.error || `Erreur HTTP ${response.status}`);
    }
    return body;
}

async function getIceServers() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) return [];
        const config = await response.json();
        return Array.isArray(config.iceServers) ? config.iceServers : [];
    } catch (_) {
        return [];
    }
}
function startIntroAnimation() {
    const firstLogo = document.getElementById('first-logo-container');
    const secondLogo = document.getElementById('second-logo-container');
    const textGif = document.getElementById('intro-text-gif');
    const userForm = document.getElementById('user-info-form');

    firstLogo.style.display = 'flex';
    secondLogo.style.display = 'none';
    userForm.style.display = 'none';

    setTimeout(() => {
        firstLogo.style.display = 'none';
        secondLogo.style.display = 'flex';

        const source = textGif.dataset.src;
        if (source) {
            textGif.src = `${source}&t=${Date.now()}`;
        }

        setTimeout(() => {
            secondLogo.style.display = 'none';
            userForm.style.display = 'flex';
        }, 1500);
    }, 3000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startIntroAnimation, { once: true });
} else {
    startIntroAnimation();
}

requestLocalMedia();
setChatAvailability(false);
updateRemoteState(false);

async function requestLocalMedia() {
    if (localStream) return localStream;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        try { await localVideo.play(); } catch (_) {}
        syncMediaButtons();
        return localStream;
    } catch (error) {
        console.error('Erreur lors de l’accès à la caméra/microphone:', error);
        showToast('Caméra ou microphone indisponible.', true);
        return null;
    }
}

document.getElementById('submit-name').addEventListener('click', async () => {
    const enteredName = document.getElementById('user-name').value.trim();
    if (!enteredName) {
        ui.welcomeHint.textContent = 'Entrez votre nom pour continuer.';
        return;
    }

    userName = enteredName;
    ui.welcomeHint.textContent = '';

    try {
        await api('/api/register', { clientId, name: userName });
    } catch (error) {
        console.error('Impossible d’enregistrer le nom:', error);
        ui.welcomeHint.textContent = 'Impossible de joindre le serveur local.';
        return;
    }

    ui.localName.textContent = userName;
    document.getElementById('logo-animation').style.opacity = '0';
    document.getElementById('user-info-form').style.display = 'none';

    setTimeout(() => {
        document.getElementById('logo-animation').style.display = 'none';
        const restOfSite = document.getElementById('rest-of-site');
        restOfSite.style.display = 'grid';
        restOfSite.style.animation = 'slideDown .45s ease forwards';
        document.body.classList.add('app-active');
        setStatus('idle', 'Prêt');
    }, 500);
});

ui.search.addEventListener('click', async () => {
    try {
        if (isSearching && !pairedUserId) {
            await api('/api/leave', { clientId });
            cleanupPeerConnection();
            resetPairState();
            setSearching(false);
            setStatus('idle', 'Prêt');
            return;
        }
        cleanupPeerConnection();
        resetPairState();
        clearChat();
        setSearching(true);
        setStatus('searching', 'Recherche…');
        await api('/api/search', { clientId });
    } catch (error) {
        console.error('Erreur lors de la recherche:', error);
        setSearching(false);
        setStatus('error', 'Erreur');
        showToast('Impossible de lancer la recherche.', true);
    }
});

events.addEventListener('ready', () => {
    if (!pairedUserId && !isSearching) setStatus('idle', 'Prêt');
});

events.addEventListener('searching', () => {
    if (!pairedUserId) {
        setSearching(true);
        setStatus('searching', 'Recherche…');
    }
});

events.addEventListener('idle', () => {
    if (!pairedUserId) {
        setSearching(false);
        setStatus('idle', 'Prêt');
    }
});

events.addEventListener('matched', async event => {
    const data = JSON.parse(event.data);

    try {
        cleanupPeerConnection();
        pairedUserId = data.peerId;
        currentMatchId = data.matchId;
        peerName = data.peerName || 'Anonyme';
        ui.peerName.textContent = peerName;
        setSearching(false);
        setStatus('connected', `Connecté · ${peerName}`);
        updateRemoteState(false);

        await preparePeerConnection(Boolean(data.initiator));
        await drainPendingSignals();

        if (data.initiator) {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            await sendSignal('offer', peerConnection.localDescription);
        }
    } catch (error) {
        console.error('Erreur pendant la mise en relation:', error);
        setStatus('error', 'Connexion impossible');
        showToast('La connexion avec ce correspondant a échoué.', true);
    }
});

events.addEventListener('signal', async event => {
    const signal = JSON.parse(event.data);

    if (!currentMatchId || !pairedUserId) {
        pendingSignals.push(signal);
        pendingSignals = pendingSignals.slice(-32);
        return;
    }

    if (signal.matchId !== currentMatchId || signal.from !== pairedUserId) return;

    try {
        await handleSignal(signal);
    } catch (error) {
        console.error('Erreur de signalisation WebRTC:', error);
    }
});

events.addEventListener('partner-left', event => {
    let data = {};
    try { data = JSON.parse(event.data); } catch (_) {}
    if (data.matchId && currentMatchId && data.matchId !== currentMatchId) return;
    if (data.peerId && pairedUserId && data.peerId !== pairedUserId) return;

    const departedName = peerName;
    const autoSearch = data.reason === 'next' || data.autoSearch === true;

    cleanupPeerConnection();
    resetPairState();
    clearChat();

    if (autoSearch) {
        setSearching(true);
        setStatus('searching', 'Recherche…');
        showToast(departedName ? `${departedName} est passé à la personne suivante.` : 'Nouvelle recherche en cours.');
    } else {
        setSearching(false);
        setStatus('idle', departedName ? `${departedName} est parti` : 'Prêt');
    }
});

events.onerror = error => {
    console.warn('Connexion au serveur de signalisation interrompue. Reconnexion automatique…', error);
    if (!pairedUserId) setStatus('error', 'Serveur indisponible');
};

async function handleSignal(signal) {
    if (!peerConnection) await preparePeerConnection(false);

    if (signal.type === 'offer') {
        await peerConnection.setRemoteDescription(signal.data);
        await flushIceCandidates();

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await sendSignal('answer', peerConnection.localDescription);
        return;
    }

    if (signal.type === 'answer') {
        await peerConnection.setRemoteDescription(signal.data);
        await flushIceCandidates();
        return;
    }

    if (signal.type === 'ice' && signal.data) {
        const candidate = new RTCIceCandidate(signal.data);
        if (peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(candidate);
        } else {
            iceCandidatesQueue.push(candidate);
        }
    }
}

async function drainPendingSignals() {
    if (!currentMatchId || !pairedUserId) return;

    const matching = pendingSignals.filter(signal =>
        signal.matchId === currentMatchId && signal.from === pairedUserId
    );
    pendingSignals = pendingSignals.filter(signal => signal.matchId !== currentMatchId);

    for (const signal of matching) {
        await handleSignal(signal);
    }
}

async function preparePeerConnection(initiator = false) {
    if (peerConnection) return peerConnection;
    if (peerConnectionPromise) return peerConnectionPromise;

    peerConnectionPromise = (async () => {
        const stream = await requestLocalMedia();
        const iceServers = await getIceServers();
        const connection = new RTCPeerConnection({ iceServers });
        peerConnection = connection;
        iceCandidatesQueue = [];

        if (stream) {
            stream.getTracks().forEach(track => connection.addTrack(track, stream));
        }

        connection.ontrack = async event => {
            if (peerConnection !== connection) return;

            const stream = event.streams?.[0] || new MediaStream([event.track]);
            remoteVideo.srcObject = stream;
            updateRemoteState(true);
            try { await remoteVideo.play(); } catch (_) {}
        };

        connection.onicecandidate = event => {
            if (event.candidate && pairedUserId && currentMatchId) {
                sendSignal('ice', event.candidate.toJSON()).catch(console.error);
            }
        };

        connection.onconnectionstatechange = () => {
            if (peerConnection !== connection) return;

            if (connection.connectionState === 'connected') {
                setStatus('connected', `Connecté · ${peerName || 'Correspondant'}`);
            } else if (connection.connectionState === 'failed') {
                setStatus('error', 'Connexion P2P interrompue');
            }
        };

        if (initiator) {
            setupDataChannel(connection.createDataChannel('uphf-meets-data', { ordered: true }));
        } else {
            connection.ondatachannel = event => setupDataChannel(event.channel);
        }

        return connection;
    })();

    try {
        return await peerConnectionPromise;
    } finally {
        peerConnectionPromise = null;
    }
}

async function flushIceCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;

    const queuedCandidates = [...iceCandidatesQueue];
    iceCandidatesQueue = [];

    for (const candidate of queuedCandidates) {
        try {
            await peerConnection.addIceCandidate(candidate);
        } catch (error) {
            console.warn('Candidat ICE ignoré:', error);
        }
    }
}

function sendSignal(type, data) {
    if (!pairedUserId || !currentMatchId) return Promise.resolve();

    return api('/api/signal', {
        clientId,
        peerId: pairedUserId,
        matchId: currentMatchId,
        type,
        data
    });
}

function setupDataChannel(channel) {
    if (dataChannel && dataChannel !== channel) {
        try { dataChannel.close(); } catch (_) {}
    }

    dataChannel = channel;
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => setChatAvailability(true);
    dataChannel.onmessage = handleDataMessage;
    dataChannel.onerror = error => console.error('Erreur DataChannel:', error);
    dataChannel.onclose = () => {
        if (dataChannel === channel) {
            dataChannel = null;
            setChatAvailability(false);
        }
    };
}

function handleDataMessage(event) {
    if (typeof event.data === 'string') {
        let payload;
        try { payload = JSON.parse(event.data); } catch (_) { return; }

        if (payload.type === 'chat' && typeof payload.message === 'string') {
            addMessageToChat(peerName || 'Anonyme', payload.message);
            return;
        }

        if (payload.type === 'file-meta') {
            const size = Number(payload.size);
            if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_SIZE) {
                incomingFile = null;
                return;
            }

            incomingFile = {
                name: String(payload.name || 'fichier').slice(0, 180),
                type: String(payload.mime || 'application/octet-stream'),
                size,
                received: 0,
                chunks: []
            };
            updateTransferProgress(`Réception de ${incomingFile.name}`, 0);
        }
        return;
    }

    if (!(event.data instanceof ArrayBuffer) || !incomingFile) return;

    incomingFile.chunks.push(event.data);
    incomingFile.received += event.data.byteLength;
    const percent = incomingFile.size === 0 ? 100 : Math.min(100, Math.round((incomingFile.received / incomingFile.size) * 100));
    updateTransferProgress(`Réception de ${incomingFile.name}`, percent);

    if (incomingFile.received >= incomingFile.size) {
        const file = incomingFile;
        incomingFile = null;
        const blob = new Blob(file.chunks, { type: file.type });
        const url = URL.createObjectURL(blob);
        addFileMessage(peerName || 'Anonyme', file.name, url);
        finishTransferProgress();
    }
}

ui.sendMessage.addEventListener('click', () => {
    const message = ui.chatMessage.value.trim();
    if (!message || !dataChannel || dataChannel.readyState !== 'open') return;

    dataChannel.send(JSON.stringify({ type: 'chat', message }));
    addMessageToChat('Vous', message);
    ui.chatMessage.value = '';
});

function addMessageToChat(sender, message) {
    removeChatPlaceholder();

    const row = document.createElement('div');
    row.className = `message-row ${sender === 'Vous' ? 'mine' : 'theirs'}`;

    const bubble = document.createElement('div');
    bubble.className = sender === 'Vous' ? 'message-user' : 'message-pair';
    bubble.textContent = message;

    const meta = document.createElement('span');
    meta.className = 'message-meta';
    meta.textContent = `${sender} · ${new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`;

    row.append(bubble, meta);
    ui.messages.appendChild(row);
    ui.messages.scrollTop = ui.messages.scrollHeight;
}

function addFileMessage(sender, fileName, url) {
    removeChatPlaceholder();

    const row = document.createElement('div');
    row.className = `message-row ${sender === 'Vous' ? 'mine' : 'theirs'}`;

    const bubble = document.createElement('div');
    bubble.className = sender === 'Vous' ? 'message-user' : 'message-pair';

    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.textContent = `Télécharger ${fileName}`;
    bubble.appendChild(link);

    const meta = document.createElement('span');
    meta.className = 'message-meta';
    meta.textContent = `${sender} · ${new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`;

    row.append(bubble, meta);
    ui.messages.appendChild(row);
    ui.messages.scrollTop = ui.messages.scrollHeight;
}

function removeChatPlaceholder() {
    document.getElementById('chat-placeholder')?.remove();
}

function clearChat() {
    ui.messages.replaceChildren();
    const placeholder = document.createElement('div');
    placeholder.id = 'chat-placeholder';
    placeholder.className = 'chat-placeholder';
    placeholder.textContent = 'Vos messages apparaîtront ici.';
    ui.messages.appendChild(placeholder);
}

function cleanupPeerConnection() {
    if (currentScreenTrack) {
        currentScreenTrack.stop();
        currentScreenTrack = null;
    }

    if (dataChannel) {
        try { dataChannel.close(); } catch (_) {}
        dataChannel = null;
    }

    if (peerConnection) {
        try {
            peerConnection.ontrack = null;
            peerConnection.onicecandidate = null;
            peerConnection.ondatachannel = null;
            peerConnection.onconnectionstatechange = null;
            peerConnection.close();
        } catch (_) {}
        peerConnection = null;
    }

    peerConnectionPromise = null;
    iceCandidatesQueue = [];
    incomingFile = null;
    remoteVideo.srcObject = null;
    updateRemoteState(false);
    setChatAvailability(false);
}

function resetPairState() {
    pairedUserId = null;
    currentMatchId = null;
    peerName = '';
    pendingSignals = [];
    ui.peerName.textContent = 'En attente';
    setChatAvailability(false);
}

function setSearching(value) {
    isSearching = value;
    ui.search.classList.toggle('searching', value);
    ui.searchLabel.textContent = value
        ? 'Annuler la recherche'
        : (pairedUserId ? 'Personne suivante' : 'Lancer la recherche');
}

function setStatus(type, text) {
    ui.status.className = `status-pill status-${type}`;
    ui.statusText.textContent = text;
}

function updateRemoteState(hasRemoteStream) {
    ui.remoteEmpty.hidden = hasRemoteStream;
    ui.fullscreen.disabled = !hasRemoteStream;
}

function setChatAvailability(enabled) {
    ui.chatMessage.disabled = !enabled;
    ui.sendMessage.disabled = !enabled;
    ui.transferFile.disabled = !enabled;
    ui.shareScreen.disabled = !pairedUserId;
    ui.chatMessage.placeholder = enabled ? 'Tapez un message...' : 'Connectez-vous à quelqu’un pour discuter';
}

function syncMediaButtons() {
    const audio = localStream?.getAudioTracks()[0];
    const video = localStream?.getVideoTracks()[0];
    ui.mic.classList.toggle('is-off', Boolean(audio && !audio.enabled));
    ui.camera.classList.toggle('is-off', Boolean(video && !video.enabled));
}

ui.mic.addEventListener('click', async () => {
    const stream = await requestLocalMedia();
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    syncMediaButtons();
});

ui.camera.addEventListener('click', async () => {
    const stream = await requestLocalMedia();
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    syncMediaButtons();
});

ui.fullscreen.addEventListener('click', async () => {
    if (!remoteVideo.srcObject) return;
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await remoteVideo.requestFullscreen();
    } catch (_) {}
});
document.getElementById('login-cas').addEventListener('click', () => {
    window.location.href = '/auth/login';
});

ui.shareScreen.addEventListener('click', async () => {
    if (!peerConnection) return;

    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = stream.getVideoTracks()[0];
        const sender = peerConnection.getSenders().find(item => item.track?.kind === 'video');
        if (!sender) {
            screenTrack.stop();
            return;
        }

        currentScreenTrack = screenTrack;
        await sender.replaceTrack(screenTrack);

        screenTrack.onended = async () => {
            currentScreenTrack = null;
            const cameraTrack = localStream?.getVideoTracks()[0];
            if (cameraTrack && peerConnection) {
                try { await sender.replaceTrack(cameraTrack); } catch (_) {}
            }
        };
    } catch (error) {
        if (error?.name !== 'NotAllowedError') console.error('Erreur partage écran:', error);
    }
});

ui.transferFile.addEventListener('click', () => {
    if (dataChannel?.readyState === 'open') ui.fileInput.click();
});

ui.fileInput.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file || dataChannel?.readyState !== 'open') return;
    if (file.size > MAX_FILE_SIZE) {
        showToast('Fichier trop volumineux : 20 Mo maximum.', true);
        return;
    }

    dataChannel.send(JSON.stringify({
        type: 'file-meta',
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size
    }));

    const buffer = await file.arrayBuffer();
    updateTransferProgress(`Envoi de ${file.name}`, 0);

    for (let offset = 0; offset < buffer.byteLength; offset += FILE_CHUNK_SIZE) {
        while (dataChannel.bufferedAmount > 1024 * 1024) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        dataChannel.send(buffer.slice(offset, offset + FILE_CHUNK_SIZE));
        const percent = buffer.byteLength === 0
            ? 100
            : Math.min(100, Math.round(((offset + FILE_CHUNK_SIZE) / buffer.byteLength) * 100));
        updateTransferProgress(`Envoi de ${file.name}`, percent);
    }

    addMessageToChat('Vous', `Fichier envoyé : ${file.name}`);
    finishTransferProgress();
});

function updateTransferProgress(label, percent) {
    ui.transferProgress.hidden = false;
    ui.transferLabel.textContent = label;
    ui.transferPercent.textContent = `${percent}%`;
    ui.transferBar.style.width = `${percent}%`;
}

function finishTransferProgress() {
    updateTransferProgress(ui.transferLabel.textContent, 100);
    setTimeout(() => {
        ui.transferProgress.hidden = true;
        ui.transferBar.style.width = '0%';
    }, 800);
}

function showToast(message, error = false) {
    clearTimeout(toastTimer);
    ui.toast.textContent = message;
    ui.toast.classList.toggle('error', error);
    ui.toast.classList.add('show');
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2400);
}

document.getElementById('user-name').addEventListener('keydown', event => {
    if (event.key === 'Enter') document.getElementById('submit-name').click();
});

ui.chatMessage.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        ui.sendMessage.click();
    }
});

window.addEventListener('beforeunload', () => {
    try {
        navigator.sendBeacon('/api/leave', new Blob([
            JSON.stringify({ clientId })
        ], { type: 'application/json' }));
    } catch (_) {}
});
