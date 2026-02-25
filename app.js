const SPOTIFY_CLIENT_ID = "1fc2d3fa12034bb283fc7e8a72b5d9ba";
const REDIRECT_URI = "http://127.0.0.1:5500/";
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state"
];

const STORAGE = {
  verifier: "discspin_pkce_verifier",
  state: "discspin_oauth_state",
  token: "discspin_token",
  tokenExpiry: "discspin_token_expiry"
};

const ui = {
  authBtn: document.querySelector("#authBtn"),
  searchInput: document.querySelector("#albumSearch"),
  searchBtn: document.querySelector("#searchBtn"),
  searchResults: document.querySelector("#searchResults"),
  cdSlot: document.querySelector("#cdSlot"),
  playToggleBtn: document.querySelector("#playToggleBtn"),
  playToggleGlyph: document.querySelector("#playToggleGlyph"),
  playToggleLabel: document.querySelector("#playToggleLabel"),
  trackList: document.querySelector("#trackList"),
  albumArt: document.querySelector("#albumArt"),
  emptyDisc: document.querySelector("#emptyDisc"),
  discHole: document.querySelector("#discHole"),
  lcdMode: document.querySelector("#lcdMode"),
  lcdTrack: document.querySelector("#lcdTrack"),
  lcdTime: document.querySelector("#lcdTime"),
  lcdAlbum: document.querySelector("#lcdAlbum"),
  lcdArtist: document.querySelector("#lcdArtist"),
  controls: Array.from(document.querySelectorAll("[data-action]"))
};

const state = {
  accessToken: null,
  player: null,
  deviceId: null,
  sdkReady: false,
  sdkConnected: false,
  currentAlbum: null,
  currentTrackIdx: 0,
  isPlaying: false,
  isStopped: true,
  controlBusy: false,
  playbackPoll: null,
  trackElapsedMs: 0,
  spinAudio: null,
  pendingDraggedAlbumId: null
};

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const soundCache = {};
const soundCandidates = {
  click: ["assets/sfx/click.mp3", "assets/sfx/click.wav"],
  insert: ["assets/sfx/insert.mp3", "assets/sfx/insert.wav"],
  eject: ["assets/sfx/eject.mp3", "assets/sfx/eject.wav"],
  spin: ["assets/sfx/spin.mp3", "assets/sfx/spin.wav"]
};

function setLcd(mode, track, time, album, artist) {
  ui.lcdMode.textContent = mode;
  ui.lcdTrack.textContent = track;
  ui.lcdTime.textContent = time;
  ui.lcdAlbum.textContent = album;
  ui.lcdArtist.textContent = artist;
}

function setControlsEnabled(enabled) {
  ui.controls.forEach((btn) => {
    btn.disabled = !enabled;
  });
}

function updatePlayPauseButton() {
  if (!ui.playToggleGlyph || !ui.playToggleLabel) {
    return;
  }
  ui.playToggleGlyph.textContent = state.isPlaying ? "||" : "▶";
  ui.playToggleLabel.textContent = state.isPlaying ? "Pause" : "Play";
}

function formatMs(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return window.crypto.subtle.digest("SHA-256", data);
}

function base64urlencode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier) {
  const hashed = await sha256(verifier);
  return base64urlencode(hashed);
}

function getTokenFromStorage() {
  const token = sessionStorage.getItem(STORAGE.token);
  const expiry = Number(sessionStorage.getItem(STORAGE.tokenExpiry));
  if (!token || !expiry || Date.now() > expiry) {
    return null;
  }
  return token;
}

async function spotifyFetch(path, options = {}) {
  if (!state.accessToken) {
    throw new Error("Missing access token");
  }

  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.accessToken}`,
      ...(options.headers || {})
    }
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Spotify API ${response.status}: ${body || "request failed"}`);
  }

  return response.json();
}

async function maybeLoadSound(paths) {
  for (const path of paths) {
    try {
      const response = await fetch(path, { method: "HEAD" });
      if (response.ok) {
        return path;
      }
    } catch (error) {
      // Ignore and continue to synth fallback.
    }
  }
  return null;
}

async function preloadSounds() {
  const entries = Object.entries(soundCandidates);
  await Promise.all(
    entries.map(async ([name, paths]) => {
      const found = await maybeLoadSound(paths);
      if (found) {
        soundCache[name] = new Audio(found);
        soundCache[name].preload = "auto";
      }
    })
  );
}

function synthTone({ frequency = 550, duration = 0.08, type = "square", gain = 0.03 }) {
  const oscillator = audioCtx.createOscillator();
  const volume = audioCtx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, audioCtx.currentTime);
  volume.gain.setValueAtTime(gain, audioCtx.currentTime);
  volume.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
  oscillator.connect(volume).connect(audioCtx.destination);
  oscillator.start();
  oscillator.stop(audioCtx.currentTime + duration);
}

function playUiSound(name) {
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }

  const sound = soundCache[name];
  if (sound) {
    sound.currentTime = 0;
    sound.play().catch(() => {});
    return;
  }

  if (name === "click") {
    synthTone({ frequency: 720, duration: 0.05, type: "square", gain: 0.02 });
    return;
  }
  if (name === "insert") {
    synthTone({ frequency: 220, duration: 0.16, type: "sawtooth", gain: 0.03 });
    setTimeout(() => synthTone({ frequency: 330, duration: 0.1, gain: 0.02 }), 60);
    return;
  }
  if (name === "eject") {
    synthTone({ frequency: 340, duration: 0.08, gain: 0.02 });
    setTimeout(() => synthTone({ frequency: 220, duration: 0.14, gain: 0.025 }), 70);
  }
}

function startSpinSound() {
  if (state.spinAudio) {
    state.spinAudio.currentTime = 0;
    state.spinAudio.play().catch(() => {});
    return;
  }

  const sound = soundCache.spin;
  if (!sound) {
    return;
  }
  state.spinAudio = sound;
  state.spinAudio.loop = true;
  state.spinAudio.volume = 0.15;
  state.spinAudio.play().catch(() => {});
}

function stopSpinSound() {
  if (state.spinAudio) {
    state.spinAudio.pause();
    state.spinAudio.currentTime = 0;
  }
}

async function login() {
  if (!SPOTIFY_CLIENT_ID || SPOTIFY_CLIENT_ID === "YOUR_SPOTIFY_CLIENT_ID") {
    alert("Set your Spotify client ID in app.js before connecting.");
    return;
  }

  const verifier = randomString(96);
  const challenge = await generateCodeChallenge(verifier);
  const oauthState = randomString(24);

  sessionStorage.setItem(STORAGE.verifier, verifier);
  sessionStorage.setItem(STORAGE.state, oauthState);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
    redirect_uri: REDIRECT_URI,
    state: oauthState
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const verifier = sessionStorage.getItem(STORAGE.verifier);
  const savedState = sessionStorage.getItem(STORAGE.state);
  const params = new URLSearchParams(window.location.search);
  const incomingState = params.get("state");

  if (!verifier || !savedState || savedState !== incomingState) {
    throw new Error("OAuth state mismatch. Try connecting again.");
  }

  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });

  const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!tokenResponse.ok) {
    throw new Error("Failed to exchange code for token.");
  }

  const tokenData = await tokenResponse.json();
  const expiresAt = Date.now() + tokenData.expires_in * 1000 - 15000;
  sessionStorage.setItem(STORAGE.token, tokenData.access_token);
  sessionStorage.setItem(STORAGE.tokenExpiry, String(expiresAt));

  window.history.replaceState({}, document.title, REDIRECT_URI);

  return tokenData.access_token;
}

function bindControlClicks() {
  document.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => playUiSound("click"));
  });
}

function clearAlbumUi() {
  state.currentAlbum = null;
  state.currentTrackIdx = 0;
  state.trackElapsedMs = 0;
  state.isPlaying = false;
  state.isStopped = true;
  stopSpinSound();

  if (ui.albumArt) {
    ui.albumArt.hidden = true;
    ui.albumArt.classList.remove("disc-spinning");
  }
  if (ui.emptyDisc) {
    ui.emptyDisc.hidden = false;
  }
  if (ui.discHole) {
    ui.discHole.hidden = true;
  }
  ui.trackList.hidden = true;
  ui.trackList.innerHTML = "";

  setLcd("STOP", "TRK --", "--:--", "No CD inserted", "Search an album to insert");
  setControlsEnabled(false);
  updatePlayPauseButton();
  updateLibraryPreviewState();
}

function renderTracks() {
  if (!state.currentAlbum) {
    ui.trackList.innerHTML = "";
    return;
  }

  ui.trackList.innerHTML = state.currentAlbum.tracks
    .map(
      (track, idx) =>
        `<li data-track-idx="${idx}" class="${idx === state.currentTrackIdx ? "active" : ""}">${track.track_number}. ${track.name}</li>`
    )
    .join("");
}

function updateDiscVisuals(isPlaying) {
  if (!state.currentAlbum) {
    return;
  }

  if (!ui.albumArt) {
    if (isPlaying) {
      startSpinSound();
    } else {
      stopSpinSound();
    }
    updateLibraryPreviewState();
    return;
  }

  if (isPlaying) {
    ui.albumArt.classList.add("disc-spinning");
    startSpinSound();
  } else {
    ui.albumArt.classList.remove("disc-spinning");
    stopSpinSound();
  }

  updateLibraryPreviewState();
}

function updateLibraryPreviewState() {
  const discs = ui.searchResults.querySelectorAll("button[data-album-id]");
  discs.forEach((disc) => {
    const isCurrent = Boolean(state.currentAlbum) && disc.dataset.albumId === state.currentAlbum.id;
    disc.classList.toggle("current-cd", isCurrent);
    disc.classList.toggle("current-cd-spinning", isCurrent && state.isPlaying);
  });
}

function createCdDragCanvas() {
  const size = 104;
  const center = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  ctx.beginPath();
  ctx.arc(center, center, 50, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#cfcfcf";
  ctx.fill();

  const grad = ctx.createRadialGradient(28, 24, 4, center, center, 52);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.5, "#d9d9d9");
  grad.addColorStop(1, "#a6a6a6");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(center, center, 48, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(center, center, 48, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(center, center, 36, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(center, center, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 3;
  ctx.stroke();

  return canvas;
}

function showToastError(message) {
  ui.lcdArtist.textContent = message;
  ui.lcdArtist.classList.add("note");
  setTimeout(() => ui.lcdArtist.classList.remove("note"), 2200);
}

async function transferPlaybackToDevice() {
  if (!state.deviceId) {
    return;
  }

  try {
    await spotifyFetch("/me/player", {
      method: "PUT",
      body: JSON.stringify({ device_ids: [state.deviceId], play: false })
    });
  } catch (error) {
    // Ignore transient transfer errors; explicit play call also targets device_id.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDeviceReady(timeoutMs = 3200) {
  if (state.deviceId) {
    return;
  }

  await primeWebPlayerElement().catch(() => {});

  const started = Date.now();
  while (!state.deviceId && Date.now() - started < timeoutMs) {
    await sleep(120);
  }

  if (!state.deviceId) {
    throw new Error("Player not ready yet");
  }
}

async function primeWebPlayerElement() {
  if (!state.player || typeof state.player.activateElement !== "function") {
    return;
  }
  try {
    await state.player.activateElement();
  } catch (error) {
    // Some browsers do not require or expose activation in all states.
  }
}

function createPlayer() {
  if (!state.sdkReady || !state.accessToken || state.player) {
    return;
  }

  const player = new window.Spotify.Player({
    name: "DiscSpin 95 Web Player",
    getOAuthToken: (cb) => cb(state.accessToken),
    volume: 0.7
  });

  player.addListener("ready", async ({ device_id: deviceId }) => {
    state.deviceId = deviceId;
    state.sdkConnected = true;
    setLcd("READY", "TRK --", "--:--", "No CD inserted", "Search and insert a CD");
  });

  player.addListener("account_error", () => {
    showToastError("Spotify Premium required for web playback");
  });

  player.addListener("authentication_error", () => {
    showToastError("Auth expired. Reconnect Spotify.");
  });

  player.addListener("player_state_changed", (snapshot) => {
    if (!snapshot || !state.currentAlbum) {
      return;
    }

    const current = snapshot.track_window.current_track;
    const idx = state.currentAlbum.tracks.findIndex((track) => track.uri === current.uri);
    if (idx >= 0) {
      state.currentTrackIdx = idx;
    }

    state.trackElapsedMs = snapshot.position;
    state.isPlaying = !snapshot.paused;
    state.isStopped = false;

    renderTracks();
    updateDiscVisuals(state.isPlaying);
    updatePlayPauseButton();

    setLcd(
      state.isPlaying ? "PLAY" : "PAUSE",
      `TRK ${String(state.currentTrackIdx + 1).padStart(2, "0")}`,
      formatMs(state.trackElapsedMs),
      state.currentAlbum.name,
      state.currentAlbum.artist
    );
  });

  player.connect();
  state.player = player;
}

async function refreshPlaybackState() {
  if (!state.currentAlbum) {
    return;
  }

  try {
    const playback = await spotifyFetch("/me/player");
    if (!playback || !playback.item) {
      return;
    }

    const item = playback.item;
    const idx = state.currentAlbum.tracks.findIndex((t) => t.uri === item.uri);
    if (idx >= 0) {
      state.currentTrackIdx = idx;
    }

    state.trackElapsedMs = playback.progress_ms || 0;
    state.isPlaying = playback.is_playing;
    renderTracks();
    updateDiscVisuals(state.isPlaying);
    updatePlayPauseButton();

    setLcd(
      state.isPlaying ? "PLAY" : "PAUSE",
      `TRK ${String(state.currentTrackIdx + 1).padStart(2, "0")}`,
      formatMs(state.trackElapsedMs),
      state.currentAlbum.name,
      state.currentAlbum.artist
    );
  } catch (error) {
    // Keep app responsive if polling fails.
  }
}

async function insertAlbum(albumId) {
  const album = await spotifyFetch(`/albums/${albumId}?market=from_token`);
  if (!album || !album.tracks?.items?.length) {
    throw new Error("No playable tracks found on this album.");
  }

  const firstPlayableOffset = album.tracks.items.findIndex((t) => t.is_playable !== false);
  if (firstPlayableOffset < 0) {
    throw new Error("This album is not playable in your region/account.");
  }

  const tracks = album.tracks.items.map((t) => ({
    id: t.id,
    name: t.name,
    uri: t.uri,
    track_number: t.track_number
  }));

  state.currentAlbum = {
    id: album.id,
    uri: album.uri,
    name: album.name,
    artist: album.artists.map((a) => a.name).join(", "),
    image: album.images?.[0]?.url || "",
    tracks
  };

  state.currentTrackIdx = firstPlayableOffset;
  state.trackElapsedMs = 0;
  state.isPlaying = false;
  state.isStopped = true;

  if (ui.emptyDisc) {
    ui.emptyDisc.hidden = true;
  }
  if (ui.albumArt) {
    ui.albumArt.hidden = false;
    ui.albumArt.src = state.currentAlbum.image;
  }
  if (ui.discHole) {
    ui.discHole.hidden = false;
  }

  renderTracks();
  ui.trackList.hidden = false;
  setControlsEnabled(true);
  updatePlayPauseButton();
  updateLibraryPreviewState();
  setLcd(
    "LOAD",
    `TRK ${String(state.currentTrackIdx + 1).padStart(2, "0")}`,
    "00:00",
    state.currentAlbum.name,
    `${state.currentAlbum.artist} - Press Play`
  );
  playUiSound("insert");

  startPlaybackPolling();
}

async function playFromCurrentPosition(forceTrackOne = false) {
  if (!state.currentAlbum) {
    return;
  }
  await ensureDeviceReady(900);

  const offset = state.currentTrackIdx;
  const positionMs = forceTrackOne ? 0 : state.trackElapsedMs;
  const query = new URLSearchParams({ device_id: state.deviceId });

  await primeWebPlayerElement();

  const body = JSON.stringify({
    context_uri: state.currentAlbum.uri,
    offset: { position: offset },
    position_ms: positionMs
  });

  try {
    await spotifyFetch(`/me/player/play?${query.toString()}`, {
      method: "PUT",
      body
    });
  } catch (error) {
    // If the device is not currently active, transfer once then retry.
    await transferPlaybackToDevice();
    await sleep(60);
    await spotifyFetch(`/me/player/play?${query.toString()}`, {
      method: "PUT",
      body
    });
  }

  state.isPlaying = true;
  state.isStopped = false;
  updateDiscVisuals(true);
  updatePlayPauseButton();
}

async function pauseOnCurrentDevice() {
  try {
    if (state.player && typeof state.player.pause === "function") {
      await state.player.pause();
    } else {
      throw new Error("SDK pause unavailable");
    }
  } catch (error) {
    await ensureDeviceReady(1200);
    await spotifyFetch(`/me/player/pause?device_id=${encodeURIComponent(state.deviceId)}`, { method: "PUT" });
  }

  state.isPlaying = false;
  updateDiscVisuals(false);
  updatePlayPauseButton();
}

async function handleControl(action) {
  if (!state.currentAlbum) {
    return;
  }

  if (action === "play") {
    if (state.isPlaying) {
      await pauseOnCurrentDevice();
      return;
    }

    if (!state.isStopped && state.player && typeof state.player.resume === "function") {
      try {
        await primeWebPlayerElement();
        await state.player.resume();
        state.isPlaying = true;
        updateDiscVisuals(true);
        updatePlayPauseButton();
        return;
      } catch (error) {
        // Fallback to Web API context play.
      }
    }

    await playFromCurrentPosition(state.isStopped);
    return;
  }

  if (action === "next") {
    await spotifyFetch(`/me/player/next?device_id=${encodeURIComponent(state.deviceId)}`, { method: "POST" });
    return;
  }

  if (action === "prev") {
    await spotifyFetch(`/me/player/previous?device_id=${encodeURIComponent(state.deviceId)}`, { method: "POST" });
    return;
  }

  if (action === "eject") {
    try {
      await spotifyFetch(`/me/player/pause?device_id=${encodeURIComponent(state.deviceId)}`, { method: "PUT" });
    } catch (error) {
      // Eject should still remove the CD from the player even if remote pause fails.
    } finally {
      playUiSound("eject");
      clearAlbumUi();
    }
  }
}

async function searchAlbums() {
  const q = ui.searchInput.value.trim();
  if (!q) {
    return;
  }

  const response = await spotifyFetch(`/search?q=${encodeURIComponent(q)}&type=album&limit=8`);
  const items = response.albums?.items || [];

  if (!items.length) {
    ui.searchResults.innerHTML = '<li class="empty-state">No albums found. Try another search.</li>';
    updateLibraryPreviewState();
    return;
  }

  ui.searchResults.innerHTML = items
    .map((album) => {
      const artist = album.artists?.map((a) => a.name).join(", ") || "Unknown Artist";
      const image = album.images?.[0]?.url || "";
      return `<li>
        <button
          data-album-id="${album.id}"
          class="disc-select"
          draggable="true"
          aria-label="Insert ${album.name} by ${artist}"
        >
          ${image ? `<img src="${image}" alt="${album.name} cover art" />` : ""}
        </button>
        <div class="album-name">${album.name}</div>
        <div class="album-artist">${artist}</div>
      </li>`;
    })
    .join("");

  updateLibraryPreviewState();
}

function bindEvents() {
  if (ui.playToggleBtn) {
    ui.playToggleBtn.addEventListener("pointerdown", () => {
      primeWebPlayerElement().catch(() => {});
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
    });
  }

  ui.authBtn.addEventListener("click", login);
  ui.searchBtn.addEventListener("click", async () => {
    try {
      await searchAlbums();
    } catch (error) {
      showToastError("Album search failed");
    }
  });

  ui.searchInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      try {
        await searchAlbums();
      } catch (error) {
        showToastError("Album search failed");
      }
    }
  });

  ui.searchResults.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-album-id]");
    if (!button) {
      return;
    }

    try {
      await primeWebPlayerElement();
      await insertAlbum(button.dataset.albumId);
    } catch (error) {
      showToastError(error.message || "Could not load this album");
    }
  });

  ui.searchResults.addEventListener("dragstart", (event) => {
    const disc = event.target.closest("button[data-album-id]");
    if (!disc || !event.dataTransfer) {
      return;
    }
    state.pendingDraggedAlbumId = disc.dataset.albumId || null;
    disc.classList.add("dragging");
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("text/plain", disc.dataset.albumId || "");
    const dragCanvas = createCdDragCanvas();
    event.dataTransfer.setDragImage(dragCanvas, 52, 52);
    primeWebPlayerElement().catch(() => {});
  });

  ui.searchResults.addEventListener("dragend", (event) => {
    const disc = event.target.closest("button[data-album-id]");
    if (!disc) {
      return;
    }
    disc.classList.remove("dragging");
    ui.cdSlot.classList.remove("drag-over");
  });

  ui.cdSlot.addEventListener("dragover", (event) => {
    event.preventDefault();
    ui.cdSlot.classList.add("drag-over");
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  });

  ui.cdSlot.addEventListener("dragleave", () => {
    ui.cdSlot.classList.remove("drag-over");
  });

  ui.cdSlot.addEventListener("drop", async (event) => {
    event.preventDefault();
    ui.cdSlot.classList.remove("drag-over");
    const albumId = event.dataTransfer?.getData("text/plain") || state.pendingDraggedAlbumId;
    state.pendingDraggedAlbumId = null;
    if (!albumId) {
      return;
    }

    try {
      await primeWebPlayerElement();
      await insertAlbum(albumId);
    } catch (error) {
      showToastError(error.message || "Could not load this album");
    }
  });

  ui.controls.forEach((button) => {
    button.addEventListener("click", async () => {
      if (state.controlBusy) {
        return;
      }

      state.controlBusy = true;
      const wasDisabled = button.disabled;
      button.disabled = true;
      try {
        await primeWebPlayerElement();
        await handleControl(button.dataset.action);
      } catch (error) {
        showToastError(error.message || "Control action failed");
      } finally {
        state.controlBusy = false;
        if (state.currentAlbum) {
          setControlsEnabled(true);
          updatePlayPauseButton();
        } else {
          setControlsEnabled(false);
        }
        if (!wasDisabled && state.currentAlbum) {
          button.disabled = false;
        }
      }
    });
  });
}

function startPlaybackPolling() {
  if (state.playbackPoll) {
    clearInterval(state.playbackPoll);
  }
  state.playbackPoll = setInterval(refreshPlaybackState, 1000);
}

async function bootstrapAuth() {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get("error");
  const code = params.get("code");

  if (authError) {
    const desc = params.get("error_description");
    throw new Error(desc ? `Spotify auth error: ${desc}` : `Spotify auth error: ${authError}`);
  }

  if (code) {
    state.accessToken = await exchangeCodeForToken(code);
  } else {
    state.accessToken = getTokenFromStorage();
  }

  if (state.accessToken) {
    ui.authBtn.textContent = "Spotify Connected";
    ui.authBtn.disabled = true;
    createPlayer();
    return;
  }

  setLcd("STOP", "TRK --", "--:--", "No CD inserted", "Connect Spotify to start");
}

function initSdkHook() {
  window.onSpotifyWebPlaybackSDKReady = () => {
    state.sdkReady = true;
    createPlayer();
  };
}

async function init() {
  clearAlbumUi();
  bindEvents();
  bindControlClicks();
  updatePlayPauseButton();
  initSdkHook();
  await preloadSounds();

  try {
    await bootstrapAuth();
  } catch (error) {
    showToastError(error.message || "Spotify auth failed");
  }
}

init();
