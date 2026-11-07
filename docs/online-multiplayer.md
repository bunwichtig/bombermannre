# Online-Multiplayer im Browser ohne eigenen Server

Eine Anleitung zum Wiederverwenden. Sie beschreibt die Technik, mit der **BombRe** (früher Funkenfeld) mehrere Spieler über das Internet verbindet, und zeigt, wie du sie in ein anderes Spiel einbaust.

Alles läuft als statische Webseite, zum Beispiel auf GitHub Pages. Du brauchst keinen eigenen Server, keine Datenbank und kein Konto.

---

## Inhalt

1. [Das Prinzip in einem Satz](#1-das-prinzip-in-einem-satz)
2. [Aufbau: Gastgeber und Mitspieler](#2-aufbau-gastgeber-und-mitspieler)
3. [Bausteine](#3-bausteine)
4. [PeerJS einbinden](#4-peerjs-einbinden)
5. [Die Transportschicht](#5-die-transportschicht)
6. [Raum und Passwort](#6-raum-und-passwort)
7. [Einladungslink](#7-einladungslink)
8. [Nachrichten-Protokoll](#8-nachrichten-protokoll)
9. [Spielschleife und Synchronisation](#9-spielschleife-und-synchronisation)
10. [Eingaben senden](#10-eingaben-senden)
11. [Testen ohne Internet: `?local`](#11-testen-ohne-internet-local)
12. [Gemeinsame Daten zusammenführen (Rangliste)](#12-gemeinsame-daten-zusammenführen-rangliste)
13. [Veröffentlichen auf GitHub Pages](#13-veröffentlichen-auf-github-pages)
14. [Stolperfallen](#14-stolperfallen)
15. [Vorlage zum Kopieren](#15-vorlage-zum-kopieren)
16. [Checkliste für ein neues Spiel](#16-checkliste-für-ein-neues-spiel)

---

## 1. Das Prinzip in einem Satz

Ein Browser erstellt den Raum und ist der **Gastgeber**: Er prüft das Passwort, berechnet das ganze Spiel und schickt den Spielstand an alle. Die anderen Browser schicken nur ihre **Eingaben** und zeichnen, was der Gastgeber ihnen schickt.

Die Verbindung läuft direkt von Browser zu Browser über **WebRTC**. Die Bibliothek **PeerJS** übernimmt das Kennenlernen der Browser über einen kostenlosen öffentlichen Vermittlungsserver.

---

## 2. Aufbau: Gastgeber und Mitspieler

```
                 ┌──────────────────────────┐
                 │  PeerJS-Vermittlung      │  nur zum Kennenlernen
                 │  (0.peerjs.com, gratis)  │  (Signalisierung)
                 └──────────┬───────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼───────┐   ┌───────▼───────┐   ┌───────▼───────┐
│  Mitspieler A │   │   GASTGEBER   │   │  Mitspieler B │
│               │   │               │   │               │
│ Eingaben ────────►│ prüft Passwort│◄──────── Eingaben │
│               │   │ rechnet Spiel │   │               │
│ ◄──────── Spielstand (20×/s) ────────────────────►    │
│ zeichnet nur  │   │ zeichnet auch │   │ zeichnet nur  │
└───────────────┘   └───────────────┘   └───────────────┘
```

Es ist ein **Stern**: Jeder Mitspieler hat genau eine Verbindung, nämlich zum Gastgeber. Die Mitspieler sind nicht untereinander verbunden.

**Warum so?**

- **Eine Wahrheit.** Nur der Gastgeber rechnet. Es kann nicht passieren, dass zwei Browser verschiedene Ergebnisse haben.
- **Schummeln ist schwer.** Mitspieler schicken nur „ich drücke nach links“. Ob das geht, entscheidet der Gastgeber.
- **Einfach.** Das Spiel selbst (die `Game`-Klasse) weiß nichts vom Netzwerk. Es bekommt Eingaben und liefert einen Schnappschuss.

**Der Preis:** Verlässt der Gastgeber das Spiel, ist es für alle vorbei. Und Mitspieler sehen alles mit einer kleinen Verzögerung (Hin- und Rückweg zum Gastgeber).

---

## 3. Bausteine

| Baustein | Wofür | Wo im Code von BombRe |
|---|---|---|
| PeerJS 1.5.4 | WebRTC-Verbindung, Vermittlung | `index.html`, `<script src="https://unpkg.com/peerjs@1.5.4/...">` |
| `Net.host()` / `Net.join()` | Raum öffnen / beitreten | `game.js`, Abschnitt „Transport“ |
| `localHost()` / `localJoin()` | Dasselbe über `BroadcastChannel` zum Testen | `game.js`, Abschnitt „Transport“ |
| `hashPw()` | Passwort nicht im Klartext senden | `game.js`, Abschnitt „Hilfen“ |
| `onClientConnect()` | Gastgeber nimmt Mitspieler an | `game.js` |
| `joinRoom()` / `onHostMessage()` | Mitspieler-Seite | `game.js` |
| `runHostLoop()` / `runClientLoop()` | Spielschleifen | `game.js`, Abschnitt „Schleifen“ |
| `Game.snapshot()` | Spielstand als kleines Objekt | `game.js`, Klasse `Game` |
| `inviteLink()` / `readInvite()` | Einladungslink bauen und lesen | `game.js` |

---

## 4. PeerJS einbinden

In der HTML-Datei, **vor** dem eigenen Skript:

```html
<script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>
<script src="game.js"></script>
```

Danach gibt es `window.Peer`. Ohne Angabe eines Servers nutzt PeerJS seinen kostenlosen öffentlichen Vermittlungsserver.

Die wichtigsten Aufrufe:

```js
// Gastgeber: mit fester, selbst gewählter Kennung anmelden
const peer = new Peer('meinspiel-v1-' + raum);
peer.on('open', () => { /* angemeldet, Raum steht */ });
peer.on('connection', (conn) => { /* jemand will rein */ });
peer.on('error', (e) => { /* e.type === 'unavailable-id' → Raum gibt es schon */ });

// Mitspieler: mit zufälliger Kennung anmelden, dann zum Gastgeber verbinden
const peer = new Peer();
peer.on('open', () => {
  const conn = peer.connect('meinspiel-v1-' + raum, { reliable: true });
  conn.on('open', () => { /* verbunden */ });
});
peer.on('error', (e) => { /* e.type === 'peer-unavailable' → Raum gibt es nicht */ });
```

Der Trick: **Der Raumname ist die Kennung des Gastgebers.** Wer den Raumnamen kennt, kann den Gastgeber finden. Eine Raumliste oder einen Lobby-Server braucht man dadurch nicht.

> **Wichtig:** Die Kennungen sind auf dem öffentlichen Server für **alle** Nutzer weltweit gültig. Darum steht ein Präfix davor (`funkenfeld-v1-`). Nimm für dein Spiel ein eigenes, eindeutiges Präfix, sonst landest du in fremden Räumen. Mit dem `v1` kannst du später inkompatible Versionen trennen.

---

## 5. Die Transportschicht

BombRe versteckt PeerJS hinter einer kleinen, einheitlichen Schnittstelle. Jede Verbindung hat:

- `send(obj)` – ein Objekt schicken
- `onData = (obj) => …` – wird bei jeder Nachricht aufgerufen
- `onClose = () => …` – wird aufgerufen, wenn die Verbindung weg ist
- `close()` – Verbindung beenden

So kann man PeerJS gegen etwas anderes tauschen (zum Beispiel den `BroadcastChannel` zum Testen, siehe Abschnitt 11), ohne das Spiel anzufassen.

Original aus `game.js`:

```js
const PEER_PREFIX = 'funkenfeld-v1-';
const LOCAL = new URLSearchParams(location.search).has('local');

// Beide Varianten liefern Verbindungen mit send(obj), onData, onClose, close().
function wrapPeerConn(c) {
  const conn = { send: (o) => { if (c.open) c.send(o); }, close: () => c.close(), onData: null, onClose: null };
  c.on('data', (d) => conn.onData && conn.onData(d));
  c.on('close', () => conn.onClose && conn.onClose());
  c.on('error', () => conn.onClose && conn.onClose());
  return conn;
}

const Net = {
  host(room, onConn) {
    return new Promise((resolve, reject) => {
      if (LOCAL) return resolve(localHost(room, onConn));
      if (!window.Peer) return reject(new Error('Netzwerk-Bibliothek konnte nicht geladen werden.'));
      const peer = new Peer(PEER_PREFIX + room);
      peer.on('open', () => resolve({ close: () => peer.destroy() }));
      peer.on('connection', (c) => c.on('open', () => onConn(wrapPeerConn(c))));
      peer.on('error', (e) => {
        if (e.type === 'unavailable-id') reject(new Error('Diesen Raum gibt es schon. Wähle einen anderen Namen oder tritt bei.'));
        else reject(new Error('Verbindungsfehler: ' + e.type));
      });
    });
  },
  join(room) {
    return new Promise((resolve, reject) => {
      if (LOCAL) return resolve(localJoin(room));
      if (!window.Peer) return reject(new Error('Netzwerk-Bibliothek konnte nicht geladen werden.'));
      const peer = new Peer();
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; peer.destroy(); reject(new Error('Keine Antwort vom Gastgeber.')); } }, 15000);
      peer.on('open', () => {
        const c = peer.connect(PEER_PREFIX + room, { reliable: true });
        c.on('open', () => {
          if (done) return; done = true; clearTimeout(timer);
          const conn = wrapPeerConn(c);
          const close = conn.close; conn.close = () => { close(); peer.destroy(); };
          resolve(conn);
        });
      });
      peer.on('error', (e) => {
        if (done) return; done = true; clearTimeout(timer); peer.destroy();
        reject(new Error(e.type === 'peer-unavailable' ? 'Diesen Raum gibt es nicht. Prüfe den Raumnamen.' : 'Verbindungsfehler: ' + e.type));
      });
    });
  },
};
```

Worauf es ankommt:

- `send` prüft `c.open`. Sonst wirft PeerJS Fehler, wenn man an eine gerade geschlossene Verbindung sendet.
- `error` auf der Verbindung wird wie `close` behandelt. Für das Spiel ist beides „Spieler weg“.
- Beim Mitspieler gibt es eine **Zeitgrenze von 15 Sekunden**. Ohne sie wartet der Knopf „Beitreten“ ewig, wenn die Verbindung hängt.
- `done` verhindert, dass Erfolg und Fehler beide ausgelöst werden.
- Beim Mitspieler schließt `close()` auch den `Peer`, damit er sich beim Server abmeldet.

---

## 6. Raum und Passwort

### Raumname vereinheitlichen

Der Raumname wird zu einer Kennung gemacht: Kleinbuchstaben, Umlaute vereinfacht, alles andere wird `-`. So finden „Kumpel Runde“ und „kumpel-runde“ denselben Raum, und PeerJS bekommt nur erlaubte Zeichen.

```js
function slug(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
```

### Passwort prüfen

Das Passwort wird **nie im Klartext** geschickt. Beide Seiten bilden einen SHA-256-Hash aus Spielname, Raum und Passwort. Der Mitspieler schickt den Hash, der Gastgeber vergleicht ihn mit seinem eigenen.

```js
async function hashPw(room, pw) {
  const text = 'funkenfeld|' + room + '|' + pw;   // eigenen Spielnamen einsetzen
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261; // Notlösung ohne sichere Umgebung (http statt https)
  for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return 'f' + (h >>> 0).toString(16);
}
```

Der Raumname steckt mit im Hash. Dadurch ergibt dasselbe Passwort in verschiedenen Räumen verschiedene Hashes.

`crypto.subtle` gibt es nur auf `https://` und `localhost`. Die Notlösung sorgt dafür, dass es auch beim Testen über eine IP-Adresse im Heimnetz funktioniert. Wichtig ist nur, dass **beide Seiten dieselbe Funktion** benutzen.

### Der Gastgeber nimmt Mitspieler an

Eine neue Verbindung ist zunächst **nicht** im Spiel. Erst wenn eine `join`-Nachricht mit dem richtigen Hash kommt, wird ein Spieler daraus. Original:

```js
function onClientConnect(conn) {
  let pid = null;
  const timeout = setTimeout(() => { if (!pid) conn.close(); }, 10000);   // wer nichts sagt, fliegt
  conn.onData = (m) => {
    if (!m || typeof m !== 'object') return;
    if (!pid) {
      if (m.t !== 'join') return;                // vor dem Beitritt zählt nur 'join'
      clearTimeout(timeout);
      const g = S.game;
      let reason = null;
      if (m.pw !== S.pwHash) reason = 'Falsches Passwort.';
      else if (g.players.length >= cleanSettings(g.settings).players) reason = `Der Raum ist voll (maximal ${cleanSettings(g.settings).players} Spieler).`;
      else if (g.phase !== 'lobby') reason = 'Das Spiel läuft schon. Warte, bis die Partie vorbei ist.';
      if (reason) { conn.send({ t: 'reject', reason }); setTimeout(() => conn.close(), 300); return; }
      pid = 'p' + Math.random().toString(36).slice(2, 8);
      g.addPlayer(pid, String(m.name || 'Spieler').slice(0, 12));
      S.conns.set(pid, conn);
      conn.send({ t: 'welcome', id: pid });
      broadcastLobby();
      return;
    }
    if (m.t === 'input') {
      const p = S.game.players.find((q) => q.id === pid);
      // Eingaben nie ungeprüft übernehmen
      if (p) p.input = { dx: Math.sign(m.dx) | 0, dy: Math.sign(m.dy) | 0, bomb: m.bomb | 0, det: m.det | 0 };
    }
  };
  conn.onClose = () => {
    if (!pid) return;
    S.conns.delete(pid);
    S.game.removePlayer(pid);
    pid = null;
    broadcastLobby();
  };
}
```

Beachte:

- Die **Spieler-ID vergibt der Gastgeber**, nicht der Mitspieler. Die ID hängt an der Verbindung (`pid` in der Closure). Ein Mitspieler kann deshalb keine fremde Figur steuern.
- Nach `reject` wartet der Gastgeber 300 ms mit dem Schließen, damit die Nachricht noch ankommt.
- Alles, was vom Mitspieler kommt, wird **zurechtgestutzt**: Namen auf 12 Zeichen, Richtungen auf −1/0/1, Zahlen mit `| 0`.

### Der Mitspieler tritt bei

```js
async function joinRoom() {
  const f = readForm(); if (!f) return;     // { name, room: slug(...), pw }
  try {
    const conn = await Net.join(f.room);
    S.role = 'client'; S.conn = conn;
    const pw = await hashPw(f.room, f.pw);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Keine Antwort vom Gastgeber.')), 10000);
      conn.onData = (m) => {
        if (m.t === 'welcome') { clearTimeout(timer); S.myId = m.id; resolve(); }
        else if (m.t === 'reject') { clearTimeout(timer); reject(new Error(m.reason)); }
      };
      conn.onClose = () => { clearTimeout(timer); reject(new Error('Verbindung getrennt.')); };
      conn.send({ t: 'join', name: f.name, pw });
    });
    // Ab hier: normaler Spielbetrieb
    conn.onData = onHostMessage;
    conn.onClose = () => { if (S.role === 'client') leave('Der Gastgeber hat das Spiel verlassen.'); };
    enterLobby();
    runClientLoop();
  } catch (e) {
    if (S.conn) S.conn.close();
    S.role = null; S.conn = null;
    showError(e.message);
  }
}
```

Der Beitritt ist zweistufig: erst die Verbindung, dann der Handschlag (`join` → `welcome` oder `reject`). Danach werden `onData` und `onClose` auf den Spielbetrieb umgestellt.

### Wie sicher ist das?

Ehrlich gesagt: **gut genug für Freunde, nicht für Geheimnisse.**

- Das Passwort hält Fremde fern, die zufällig denselben Raumnamen wählen oder raten.
- Der Hash wird übertragen, nicht das Passwort. Die WebRTC-Verbindung selbst ist ohnehin verschlüsselt (DTLS).
- Wer aber den Code liest, kann beliebig viele Passwörter durchprobieren. Es gibt keine Sperre nach Fehlversuchen. Willst du das, zähle im Gastgeber Fehlversuche und schließe danach.
- Der Gastgeber muss dem Spielcode vertrauen, den alle laden. Das ist bei einer eigenen GitHub-Pages-Seite gegeben.

---

## 7. Einladungslink

Der Link sieht so aus:

```
https://bunwichtig.github.io/bombermannre/#raum=kumpel-runde&pw=geheim
```

Raum (und auf Wunsch das Passwort) stehen **hinter dem `#`**. Dieser Teil der Adresse wird vom Browser **nie an einen Server geschickt**. Er taucht also auch nicht in Server-Logs auf.

Link bauen (Gastgeber, in der Lobby):

```js
function inviteLink() {
  const p = new URLSearchParams({ raum: S.room });
  if ($('inv-pw').checked && S.pw) p.set('pw', S.pw);    // Passwort nur, wenn angehakt
  return location.origin + location.pathname + (LOCAL ? '?local' : '') + '#' + p.toString();
}
```

Kopieren, mit Rückfall für ältere Browser:

```js
async function copyInvite() {
  const link = inviteLink();
  let ok = false;
  try { await navigator.clipboard.writeText(link); ok = true; } catch (e) {
    const el = $('inv-link'); el.focus(); el.select();
    try { ok = document.execCommand('copy'); } catch (e2) {}
  }
  $('btn-copy').textContent = ok ? 'Kopiert ✓' : 'Bitte markieren & kopieren';
}
```

Auf dem Handy gibt es zusätzlich einen „Teilen“-Knopf, wenn `navigator.share` vorhanden ist:

```js
if (navigator.share) {
  $('btn-share').addEventListener('click', () => {
    navigator.share({ title: 'Mein Spiel', text: 'Spiel mit mir, Raum „' + S.room + '“:', url: inviteLink() }).catch(() => {});
  });
}
```

Link lesen (beim Öffnen der Seite):

```js
(function readInvite() {
  const h = new URLSearchParams(location.hash.slice(1));
  const room = slug(h.get('raum') || '');
  if (!room) return;
  $('in-room').value = room;
  if (h.get('pw')) $('in-pass').value = h.get('pw');
  // Link aus der Adresszeile nehmen, damit das Passwort nicht im Verlauf stehen bleibt
  history.replaceState(null, '', location.pathname + location.search);
  // Hinweis zeigen, „Beitreten“ hervorheben, das passende Feld fokussieren
})();
```

`history.replaceState` entfernt das Passwort aus der Adresszeile. Lädt jemand die Seite neu oder kopiert die Adresse, ist es nicht mehr drin.

---

## 8. Nachrichten-Protokoll

Jede Nachricht ist ein einfaches Objekt mit dem Feld `t` (Typ). PeerJS verpackt Objekte selbst, man muss nichts mit `JSON.stringify` machen.

**Mitspieler → Gastgeber**

| `t` | Inhalt | Wann |
|---|---|---|
| `join` | `name`, `pw` (Hash), `matches` (Rangliste) | Einmal direkt nach dem Verbinden |
| `input` | `dx`, `dy`, `bomb`, `det` | Bei jeder Änderung und alle 250 ms |

**Gastgeber → Mitspieler**

| `t` | Inhalt | Wann |
|---|---|---|
| `welcome` | `id` (eigene Spieler-ID) | Beitritt angenommen |
| `reject` | `reason` (Text für den Spieler) | Beitritt abgelehnt |
| `lobby` | `players`, `phase`, `settings` | Bei jeder Änderung in der Lobby |
| `state` | ganzer Spielstand (siehe unten) | 20-mal pro Sekunde während des Spiels |
| `matches` | `list` (Rangliste) | Nach Beitritt und nach jedem Spielende |

Der Mitspieler verteilt die Nachrichten so:

```js
function onHostMessage(m) {
  if (m.t === 'lobby') renderLobby(m);
  else if (m.t === 'matches') { mergeMatches(m.list); renderRanking(); }
  else if (m.t === 'state') {
    S.view = m;                                   // nur merken, gezeichnet wird in der Schleife
    if (m.phase !== 'lobby' && !inGame()) show('game');
  }
}
```

An alle schicken (Gastgeber):

```js
function broadcast(msg) { for (const c of S.conns.values()) c.send(msg); }
```

**Tipp für dein Spiel:** Behalte die Typen `join`, `welcome`, `reject`, `lobby`, `state`, `input` bei. Sie passen auf fast jedes Echtzeitspiel. Nur der Inhalt von `state` und `input` ändert sich.

---

## 9. Spielschleife und Synchronisation

### Der Schnappschuss

Die `Game`-Klasse hat eine Methode `snapshot()`. Sie liefert **alles, was man zum Zeichnen braucht, und nicht mehr**. Er muss klein sein, weil er 20-mal pro Sekunde an jeden Mitspieler geht.

```js
snapshot() {
  return {
    t: 'state', w: W, h: H, phase: this.phase, round: this.round, msg: this.msg,
    clock: Math.max(0, Math.ceil(this.clock)),
    grid: this.grid.join(''),                                // Feld als ein String statt Array
    players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive,
      x: +p.x.toFixed(3), y: +p.y.toFixed(3), dir: p.dir, moving: p.moving /* … */ })),
    bombs: this.bombs.map((b) => [b.x, b.y, +b.fuse.toFixed(2), b.remote ? 1 : 0]),   // Arrays statt Objekte
    flames: this.flames.map((f) => [f.x, f.y]),
    items: this.items.map((i) => [i.x, i.y, i.type]),
  };
}
```

Spartricks: Zahlen runden (`toFixed`), das Spielfeld als einen String schicken, viele kleine Dinge als Arrays statt als Objekte mit Feldnamen.

### Gastgeber-Schleife

Feste Schrittweite: Die Simulation läuft immer mit 60 Schritten pro Sekunde, egal wie schnell der Bildschirm ist. Nur jeder dritte Schritt wird verschickt (20 Hz).

```js
const TICK = 1 / 60, SEND_EVERY = 3;   // Simulation 60 Hz, Senden 20 Hz

function runHostLoop() {
  const id = ++loopId;
  let last = performance.now(), acc = 0, n = 0;
  const tick = (now) => {
    acc += Math.min(0.25, (now - last) / 1000); last = now;   // große Sprünge kappen
    const g = S.game;
    const me = g.players.find((p) => p.id === 'host'); if (me) me.input = { ...S.input };
    while (acc >= TICK) {
      g.step(TICK); acc -= TICK;
      if (++n % SEND_EVERY === 0) {
        const snap = g.snapshot();
        for (const c of S.conns.values()) c.send(snap);
      }
    }
  };
  const frame = (now) => {
    if (id !== loopId || S.role !== 'host') return;       // alte Schleife beenden
    tick(now);
    S.view = S.game.snapshot();
    draw(S.view, true);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // Weiterrechnen, wenn der Tab im Hintergrund ist (requestAnimationFrame pausiert dann)
  const bg = setInterval(() => {
    if (id !== loopId || S.role !== 'host') return clearInterval(bg);
    if (document.hidden) tick(performance.now());
  }, 50);
}
```

Drei Dinge, die man leicht vergisst:

1. **`loopId`**: Jede neue Schleife bekommt eine Nummer. Eine alte Schleife merkt dadurch, dass sie aufhören soll (zum Beispiel nach „Verlassen“ und neu Beitreten).
2. **Hintergrund-Tab**: Browser pausieren `requestAnimationFrame` in Tabs, die man nicht sieht. Wechselt der Gastgeber kurz zu WhatsApp, würde das Spiel für alle einfrieren. Darum rechnet ein `setInterval` weiter.
3. **`Math.min(0.25, …)`**: Kommt der Tab nach langer Pause zurück, rechnet das Spiel nicht hunderte Schritte nach.

Der Gastgeber zeichnet seinen eigenen Schnappschuss mit derselben `draw()`-Funktion. Es gibt also nur **eine** Zeichenfunktion für beide Rollen.

### Mitspieler-Schleife und Glättung

Der Mitspieler rechnet nichts. Er zeichnet bei jedem Bild den zuletzt empfangenen Stand (`S.view`).

Weil nur 20 Stände pro Sekunde kommen, der Bildschirm aber 60 Bilder zeigt, würden Figuren ruckeln. Darum werden die angezeigten Positionen **geglättet**: Jedes Bild läuft die Figur 35 % des Wegs zur neuesten Position.

```js
for (const p of v.players) {
  let d = S.disp.get(p.id);
  // Gastgeber oder großer Sprung (neue Runde, Teleport): sofort hinsetzen
  if (!d || isHost || Math.hypot(d.x - p.x, d.y - p.y) > 2) d = { x: p.x, y: p.y };
  else { d.x += (p.x - d.x) * 0.35; d.y += (p.y - d.y) * 0.35; }
  S.disp.set(p.id, d);
  drawPlayer(d.x * T, d.y * T, p);
}
```

Das ist einfacher als echte Interpolation zwischen zwei Ständen und sieht für die meisten Spiele gut genug aus. Nur bewegte Dinge brauchen das, Wände und Gegenstände nicht.

---

## 10. Eingaben senden

Die Eingabe ist ein kleines Objekt, das immer den **aktuellen Zustand** beschreibt:

```js
S.input = { dx: 0, dy: 0, bomb: 0, det: 0 };
```

- `dx`, `dy`: aktuelle Richtung (−1, 0 oder 1).
- `bomb`, `det`: **Zähler**, kein Ja/Nein. Jeder Tastendruck erhöht den Zähler um 1.

**Warum Zähler?** Ein kurzer Tastendruck („Bombe legen“) könnte zwischen zwei Nachrichten passieren und verloren gehen, wenn man nur `bomb: true/false` schickt. Mit einem Zähler sieht der Gastgeber: „Der Wert ist von 4 auf 5 gestiegen, also eine Bombe legen.“ Kommt dieselbe Nachricht zweimal, passiert nichts doppelt.

```js
function bomb() { S.input.bomb = (S.input.bomb + 1) % 1000; }

// Im Spiel (Gastgeber), pro Spieler:
if (p.input.bomb !== p.lastBomb) { p.lastBomb = p.input.bomb; placeBomb(p); }
```

Mitspieler-Schleife: senden, wenn sich etwas ändert, und zusätzlich alle 250 ms zur Sicherheit.

```js
function runClientLoop() {
  const id = ++loopId;
  const frame = () => {
    if (id !== loopId || S.role !== 'client') return;
    const key = S.input.dx + ',' + S.input.dy + ',' + S.input.bomb + ',' + S.input.det;
    if (key !== S.lastSent) { S.lastSent = key; S.conn.send({ t: 'input', ...S.input }); }
    if (S.view) draw(S.view, false);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const iv = setInterval(() => {
    if (id !== loopId || S.role !== 'client') return clearInterval(iv);
    S.conn && S.conn.send({ t: 'input', ...S.input });
  }, 250);
}
```

Weil immer der ganze Zustand geschickt wird, macht eine verlorene oder doppelte Nachricht nichts kaputt. Die nächste repariert alles.

---

## 11. Testen ohne Internet: `?local`

Hängt man `?local` an die Adresse, läuft alles über einen **`BroadcastChannel`**. Damit sprechen Tabs **desselben Browsers** miteinander, ganz ohne Netzwerk und ohne PeerJS-Server.

So testest du: Tab 1 öffnen mit `index.html?local`, Raum erstellen. Tab 2 mit derselben Adresse öffnen, beitreten. Fertig.

Die Ersatz-Funktionen liefern Verbindungen mit derselben Schnittstelle (`send`, `onData`, `onClose`, `close`):

```js
function localHost(room, onConn) {
  const bc = new BroadcastChannel('ff-' + room);
  const conns = new Map();
  bc.onmessage = ({ data: m }) => {
    if (m.to !== 'host') return;
    if (m.hello) {
      const conn = { send: (o) => bc.postMessage({ to: m.from, d: o }),
                     close: () => { bc.postMessage({ to: m.from, bye: 1 }); conns.delete(m.from); },
                     onData: null, onClose: null };
      conns.set(m.from, conn); onConn(conn);
      bc.postMessage({ to: m.from, ok: 1 });
    } else if (m.bye) { const c = conns.get(m.from); conns.delete(m.from); c && c.onClose && c.onClose(); }
    else { const c = conns.get(m.from); c && c.onData && c.onData(m.d); }
  };
  return { close: () => { for (const [id] of conns) bc.postMessage({ to: id, bye: 1 }); bc.close(); } };
}

function localJoin(room) {
  return new Promise((resolve, reject) => {
    const bc = new BroadcastChannel('ff-' + room);
    const me = Math.random().toString(36).slice(2);
    const conn = { send: (o) => bc.postMessage({ to: 'host', from: me, d: o }),
                   close: () => { bc.postMessage({ to: 'host', from: me, bye: 1 }); bc.close(); },
                   onData: null, onClose: null };
    const timer = setTimeout(() => { bc.close(); reject(new Error('Diesen Raum gibt es nicht.')); }, 1500);
    bc.onmessage = ({ data: m }) => {
      if (m.to !== me) return;
      if (m.ok) { clearTimeout(timer); resolve(conn); }
      else if (m.bye) { conn.onClose && conn.onClose(); }
      else conn.onData && conn.onData(m.d);
    };
    bc.postMessage({ to: 'host', from: me, hello: 1 });
  });
}
```

Ein `BroadcastChannel` erreicht alle Tabs. Darum steht in jeder Nachricht `to` und `from`, und jeder Tab ignoriert, was nicht an ihn geht.

Das spart beim Entwickeln viel Zeit: kein zweites Gerät, keine Abhängigkeit vom PeerJS-Server, und man sieht Fehler sofort in beiden Tabs.

---

## 12. Gemeinsame Daten zusammenführen (Rangliste)

Es gibt keinen Server, also auch keine zentrale Rangliste. BombRe speichert jedes beendete Spiel im `localStorage` jedes Browsers. Beim Beitreten **tauschen Gastgeber und Mitspieler ihre Listen aus** und führen sie zusammen. So haben nach und nach alle denselben Stand.

Damit das ohne Doppelungen klappt:

- Jeder Eintrag hat eine **eindeutige ID** (`Date.now().toString(36) + Zufall`).
- Beim Zusammenführen wird nur hinzugefügt, was es noch nicht gibt.
- Jeder fremde Eintrag wird **geprüft und zurechtgestutzt** (`cleanMatch`), bevor er gespeichert wird.
- Die Liste ist begrenzt (300 Einträge), damit `localStorage` nicht vollläuft.

```js
function mergeMatches(list) {
  if (!Array.isArray(list)) return false;
  const all = loadMatches(); const ids = new Set(all.map((m) => m.id));
  let added = false;
  for (const raw of list.slice(-RANK_MAX)) {
    const m = cleanMatch(raw);
    if (m && !ids.has(m.id)) { all.push(m); ids.add(m.id); added = true; }
  }
  if (added) {
    all.sort((a, b) => a.date - b.date);
    try { localStorage.setItem(RANK_KEY, JSON.stringify(all.slice(-RANK_MAX))); } catch (e) {}
  }
  return added;
}
```

Das Muster passt für alles, was „alle irgendwann gleich haben sollen“: Bestenlisten, freigeschaltete Level, Spielerprofile.

`localStorage` immer in `try/catch` packen. Im privaten Modus mancher Browser wirft schon der Zugriff einen Fehler.

---

## 13. Veröffentlichen auf GitHub Pages

Das Spiel besteht nur aus `index.html`, `game.js` und `style.css`. GitHub Pages reicht völlig.

Ein Problem gibt es: GitHub Pages lässt Browser Dateien **bis zu 10 Minuten zwischenspeichern**. Nach einem Update haben Gastgeber und Mitspieler dann womöglich **verschiedene Versionen**, und die Nachrichten passen nicht mehr zusammen.

BombRe löst das so:

1. Im Code steht `const VERSION = '__VERSION__';` und in der HTML `game.js?v=__VERSION__`.
2. Der GitHub-Actions-Workflow ersetzt `__VERSION__` beim Veröffentlichen durch die Commit-Kennung und schreibt sie in `version.txt`:

   ```yaml
   - name: Version eintragen
     run: |
       V="${GITHUB_SHA::7}"
       sed -i "s/__VERSION__/$V/g" index.html game.js
       echo "$V" > version.txt
   ```

3. Das Spiel fragt `version.txt` regelmäßig ohne Cache ab und zeigt bei einer neuen Version einen Knopf „Neu laden“:

   ```js
   const r = await fetch('version.txt?t=' + Date.now(), { cache: 'no-store' });
   const v = (await r.text()).trim();
   if (v && v !== VERSION) showUpdateBar();
   ```

Wenn du das Protokoll grundlegend änderst, erhöhe zusätzlich das Präfix (`meinspiel-v2-`). Dann finden alte und neue Versionen sich gar nicht erst.

In den Repo-Einstellungen unter **Settings → Pages** als Quelle „GitHub Actions“ wählen.

---

## 14. Stolperfallen

**Manche Verbindungen klappen nicht.**
PeerJS nutzt nur STUN-Server (zum Herausfinden der eigenen Adresse). Sitzen beide hinter strengen Firewalls oder „symmetrischem NAT“ (manche Firmennetze, manche Mobilfunknetze), klappt die direkte Verbindung nicht. Dann hilft nur ein TURN-Server, der die Daten weiterleitet. Kostenlose TURN-Server sind selten und unzuverlässig. Man kann einen eigenen angeben:

```js
const peer = new Peer(id, { config: { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:dein-turn-server:3478', username: '…', credential: '…' },
] } });
```

Für die meisten Heimnetze und WLANs ist das nicht nötig. Bei Problemen: ein Spieler wechselt vom Mobilfunk ins WLAN oder umgekehrt.

**Der öffentliche PeerJS-Server ist kostenlos, aber ohne Garantie.**
Fällt er aus, kann niemand neue Räume erstellen. Laufende Spiele laufen weiter, weil die Daten direkt fließen. Wer es zuverlässig braucht, betreibt einen eigenen `peerjs-server` (Node.js) und gibt ihn mit `new Peer(id, { host, port, path })` an.

**Raumnamen sind weltweit.**
Zwei Leute auf der Welt, die denselben Raumnamen mit demselben Präfix wählen, kollidieren. Der Zweite bekommt „Diesen Raum gibt es schon“. Eindeutiges Präfix wählen.

**Die Kennung bleibt kurz reserviert.**
Schließt der Gastgeber den Tab und erstellt sofort denselben Raum neu, kann der Server die alte Kennung noch ein paar Sekunden für belegt halten (`unavailable-id`). Kurz warten oder anderen Namen nehmen.

**Gastgeber weg = Spiel weg.**
Es gibt keine Übergabe an einen anderen Gastgeber. Für Freunde-Runden ist das in Ordnung. Wer mehr will, muss den ganzen Spielstand an einen neuen Gastgeber übergeben, das ist deutlich aufwändiger.

**Handy schläft ein.**
Geht das Handy des Gastgebers in den Ruhezustand, friert das Spiel trotz `setInterval` ein. Am besten spielt der Gastgeber am Rechner. Optional kann man die Wake-Lock-API (`navigator.wakeLock.request('screen')`) nutzen.

**Nie den Daten der Mitspieler trauen.**
Alles, was ankommt, prüfen und begrenzen: Typen, Zahlenbereiche, Textlängen. Namen beim Anzeigen immer escapen (`esc()`), sonst kann jemand HTML einschleusen.

**PeerJS über CDN.**
Ist `unpkg.com` nicht erreichbar oder blockiert, fehlt `window.Peer`. Darum die Prüfung `if (!window.Peer)` mit verständlicher Fehlermeldung. Alternativ die Datei `peerjs.min.js` ins eigene Repo legen.

**Zu große Schnappschüsse.**
Jedes Byte geht 20-mal pro Sekunde an jeden Mitspieler. Bei 6 Spielern muss der Gastgeber das Fünffache hochladen. Schnappschuss klein halten, nicht ändernde Dinge (zum Beispiel Einstellungen) nur in der Lobby schicken.

**Echte Spieler-Bewegung fühlt sich verzögert an.**
Der Mitspieler sieht seine eigene Figur erst, wenn der Gastgeber geantwortet hat (typisch 30–100 ms). Für BombRe reicht das. Für schnelle Shooter bräuchte man „Client-Vorhersage“: die eigene Figur sofort lokal bewegen und später mit dem Gastgeber abgleichen.

---

## 15. Vorlage zum Kopieren

Ein eigenständiges Grundgerüst, das du in ein neues Spiel kopieren kannst. Du ergänzt nur die Spiellogik (`Game`) und das Zeichnen (`draw`). Die Transportfunktionen `Net`, `wrapPeerConn`, `localHost`, `localJoin` aus Abschnitt 5 und 11 und `hashPw`, `slug` aus Abschnitt 6 übernimmst du unverändert (nur Präfix und Spielnamen anpassen).

```html
<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><title>Mein Spiel</title></head>
<body>
  <div id="start">
    <input id="in-name" placeholder="Dein Name">
    <input id="in-room" placeholder="Raumname">
    <input id="in-pass" type="password" placeholder="Passwort">
    <button id="btn-host">Raum erstellen</button>
    <button id="btn-join">Raum beitreten</button>
    <p id="msg"></p>
  </div>
  <div id="lobby" hidden>
    <input id="inv-link" readonly> <label><input id="inv-pw" type="checkbox"> Passwort in den Link</label>
    <ul id="players"></ul>
    <button id="btn-start" hidden>Spiel starten</button>
  </div>
  <canvas id="cv" width="640" height="480" hidden></canvas>
  <script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>
  <script src="net.js"></script>   <!-- Net, localHost, localJoin, hashPw, slug -->
  <script src="game.js"></script>
</body>
</html>
```

```js
// game.js – Grundgerüst
const $ = (id) => document.getElementById(id);
const TICK = 1 / 60, SEND_EVERY = 3;

// ---- Spiellogik: weiß nichts vom Netzwerk ----
class Game {
  constructor() { this.players = []; this.phase = 'lobby'; }
  addPlayer(id, name) { this.players.push({ id, name, x: 100, y: 100, input: { dx: 0, dy: 0, act: 0 }, lastAct: 0 }); }
  removePlayer(id) { this.players = this.players.filter((p) => p.id !== id); }
  start() { this.phase = 'play'; }
  step(dt) {
    if (this.phase !== 'play') return;
    for (const p of this.players) {
      p.x += p.input.dx * 200 * dt; p.y += p.input.dy * 200 * dt;
      if (p.input.act !== p.lastAct) { p.lastAct = p.input.act; /* Aktion auslösen */ }
    }
  }
  snapshot() {
    return { t: 'state', phase: this.phase,
      players: this.players.map((p) => ({ id: p.id, name: p.name, x: +p.x.toFixed(1), y: +p.y.toFixed(1) })) };
  }
}

// ---- Zustand ----
const S = { role: null, room: '', pw: '', pwHash: '', myId: null, game: null, hostNet: null,
  conns: new Map(), conn: null, view: null, disp: new Map(), input: { dx: 0, dy: 0, act: 0 }, lastSent: '' };
let loopId = 0;
const broadcast = (msg) => { for (const c of S.conns.values()) c.send(msg); };

function readForm() {
  const name = ($('in-name').value.trim() || 'Spieler').slice(0, 12);
  const room = slug($('in-room').value), pw = $('in-pass').value;
  if (!room || !pw) { $('msg').textContent = 'Raum und Passwort eingeben.'; return null; }
  return { name, room, pw };
}

// ---- Gastgeber ----
async function hostRoom() {
  const f = readForm(); if (!f) return;
  try {
    Object.assign(S, { role: 'host', room: f.room, pw: f.pw, pwHash: await hashPw(f.room, f.pw), myId: 'host', game: new Game() });
    S.game.addPlayer('host', f.name);
    S.hostNet = await Net.host(f.room, onClientConnect);
    enterLobby(); runHostLoop();
  } catch (e) { S.role = null; $('msg').textContent = e.message; }
}

function onClientConnect(conn) {
  let pid = null;
  const timeout = setTimeout(() => { if (!pid) conn.close(); }, 10000);
  conn.onData = (m) => {
    if (!m || typeof m !== 'object') return;
    if (!pid) {
      if (m.t !== 'join') return;
      clearTimeout(timeout);
      let reason = null;
      if (m.pw !== S.pwHash) reason = 'Falsches Passwort.';
      else if (S.game.players.length >= 6) reason = 'Der Raum ist voll.';
      else if (S.game.phase !== 'lobby') reason = 'Das Spiel läuft schon.';
      if (reason) { conn.send({ t: 'reject', reason }); setTimeout(() => conn.close(), 300); return; }
      pid = 'p' + Math.random().toString(36).slice(2, 8);
      S.game.addPlayer(pid, String(m.name || 'Spieler').slice(0, 12));
      S.conns.set(pid, conn);
      conn.send({ t: 'welcome', id: pid });
      broadcastLobby();
    } else if (m.t === 'input') {
      const p = S.game.players.find((q) => q.id === pid);
      if (p) p.input = { dx: Math.sign(m.dx) | 0, dy: Math.sign(m.dy) | 0, act: m.act | 0 };
    }
  };
  conn.onClose = () => { if (!pid) return; S.conns.delete(pid); S.game.removePlayer(pid); pid = null; broadcastLobby(); };
}

function broadcastLobby() {
  const msg = { t: 'lobby', phase: S.game.phase, players: S.game.players.map((p) => ({ id: p.id, name: p.name })) };
  broadcast(msg); renderLobby(msg);
}

function runHostLoop() {
  const id = ++loopId; let last = performance.now(), acc = 0, n = 0;
  const tick = (now) => {
    acc += Math.min(0.25, (now - last) / 1000); last = now;
    const me = S.game.players.find((p) => p.id === 'host'); if (me) me.input = { ...S.input };
    while (acc >= TICK) { S.game.step(TICK); acc -= TICK; if (++n % SEND_EVERY === 0) broadcast(S.game.snapshot()); }
  };
  const frame = (now) => { if (id !== loopId) return; tick(now); draw(S.game.snapshot(), true); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  const bg = setInterval(() => { if (id !== loopId) return clearInterval(bg); if (document.hidden) tick(performance.now()); }, 50);
}

// ---- Mitspieler ----
async function joinRoom() {
  const f = readForm(); if (!f) return;
  try {
    const conn = await Net.join(f.room);
    Object.assign(S, { role: 'client', room: f.room, pw: f.pw, conn });
    const pw = await hashPw(f.room, f.pw);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Keine Antwort vom Gastgeber.')), 10000);
      conn.onData = (m) => {
        if (m.t === 'welcome') { clearTimeout(timer); S.myId = m.id; resolve(); }
        else if (m.t === 'reject') { clearTimeout(timer); reject(new Error(m.reason)); }
      };
      conn.onClose = () => { clearTimeout(timer); reject(new Error('Verbindung getrennt.')); };
      conn.send({ t: 'join', name: f.name, pw });
    });
    conn.onData = (m) => {
      if (m.t === 'lobby') renderLobby(m);
      else if (m.t === 'state') { S.view = m; if (m.phase !== 'lobby') showGame(); }
    };
    conn.onClose = () => leave('Der Gastgeber hat das Spiel verlassen.');
    enterLobby(); runClientLoop();
  } catch (e) { if (S.conn) S.conn.close(); S.role = null; S.conn = null; $('msg').textContent = e.message; }
}

function runClientLoop() {
  const id = ++loopId;
  const frame = () => {
    if (id !== loopId) return;
    const key = S.input.dx + ',' + S.input.dy + ',' + S.input.act;
    if (key !== S.lastSent) { S.lastSent = key; S.conn.send({ t: 'input', ...S.input }); }
    if (S.view) draw(S.view, false);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const iv = setInterval(() => { if (id !== loopId) return clearInterval(iv); S.conn && S.conn.send({ t: 'input', ...S.input }); }, 250);
}

// ---- Gemeinsam ----
function leave(reason) {
  loopId++;
  if (S.role === 'host') { for (const c of S.conns.values()) c.close(); S.hostNet && S.hostNet.close(); }
  else if (S.conn) { const c = S.conn; S.conn = null; c.close(); }
  Object.assign(S, { role: null, game: null, hostNet: null, conns: new Map(), conn: null, view: null, myId: null });
  $('start').hidden = false; $('lobby').hidden = true; $('cv').hidden = true;
  $('msg').textContent = reason || '';
}

function inviteLink() {
  const p = new URLSearchParams({ raum: S.room });
  if ($('inv-pw').checked) p.set('pw', S.pw);
  return location.origin + location.pathname + location.search + '#' + p;
}
function enterLobby() { $('start').hidden = true; $('lobby').hidden = false; $('inv-link').value = inviteLink(); if (S.role === 'host') broadcastLobby(); }
function renderLobby(m) {
  $('players').innerHTML = m.players.map((p) => `<li>${esc(p.name)}${p.id === S.myId ? ' (du)' : ''}</li>`).join('');
  $('btn-start').hidden = S.role !== 'host';
}
function showGame() { $('lobby').hidden = true; $('cv').hidden = false; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function draw(v, isHost) {
  const ctx = $('cv').getContext('2d'); ctx.clearRect(0, 0, 640, 480);
  for (const p of v.players) {
    let d = S.disp.get(p.id);
    if (!d || isHost || Math.hypot(d.x - p.x, d.y - p.y) > 100) d = { x: p.x, y: p.y };
    else { d.x += (p.x - d.x) * 0.35; d.y += (p.y - d.y) * 0.35; }
    S.disp.set(p.id, d);
    ctx.fillRect(d.x - 10, d.y - 10, 20, 20);
  }
}

// ---- Eingabe ----
const KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
addEventListener('keydown', (e) => {
  if (KEYS[e.code]) [S.input.dx, S.input.dy] = KEYS[e.code];
  else if (e.code === 'Space' && !e.repeat) S.input.act = (S.input.act + 1) % 1000;   // Zähler!
});
addEventListener('keyup', (e) => { if (KEYS[e.code]) S.input.dx = S.input.dy = 0; });

// ---- Knöpfe und Einladungslink ----
$('btn-host').onclick = hostRoom;
$('btn-join').onclick = joinRoom;
$('btn-start').onclick = () => { S.game.start(); broadcastLobby(); showGame(); };
$('inv-pw').onchange = () => { $('inv-link').value = inviteLink(); };
(function readInvite() {
  const h = new URLSearchParams(location.hash.slice(1));
  const room = slug(h.get('raum') || ''); if (!room) return;
  $('in-room').value = room; if (h.get('pw')) $('in-pass').value = h.get('pw');
  history.replaceState(null, '', location.pathname + location.search);
  $('msg').textContent = 'Du bist eingeladen. Name eingeben und „Raum beitreten“ drücken.';
})();
```

---

## 16. Checkliste für ein neues Spiel

- [ ] Eigenes **Präfix** für die Peer-Kennung wählen (`meinspiel-v1-`).
- [ ] Eigenen **Spielnamen** in `hashPw` einsetzen.
- [ ] Eigenes Präfix für den **`BroadcastChannel`** und die **`localStorage`-Schlüssel**.
- [ ] `Game` so bauen, dass es **nichts vom Netzwerk** weiß: `addPlayer`, `removePlayer`, `step(dt)`, `snapshot()`.
- [ ] **`snapshot()` klein halten**: runden, Arrays statt Objekte, Unveränderliches nur in der Lobby.
- [ ] **Eingaben als Zustand** schicken, kurze Aktionen als **Zähler**.
- [ ] Alles vom Mitspieler **prüfen und begrenzen**, Namen beim Anzeigen **escapen**.
- [ ] Spieler-IDs **vergibt der Gastgeber**.
- [ ] **Zeitgrenzen** beim Beitreten (Verbindung und Handschlag).
- [ ] **Hintergrund-Tab** des Gastgebers mit `setInterval` weiterrechnen lassen.
- [ ] Mit **`?local`** in zwei Tabs testen, dann mit zwei Geräten über das Internet.
- [ ] Auf GitHub Pages **Versionskennung** einbauen, damit alle dieselbe Version spielen.
- [ ] Klare **Fehlermeldungen** für: Raum gibt es schon, Raum gibt es nicht, falsches Passwort, Raum voll, Spiel läuft, Gastgeber weg.
