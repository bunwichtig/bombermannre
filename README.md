# BombRe

Eine Bomben-Arena für 2 bis 6 Spieler direkt im Browser. Eigene Grafik, klassische Regeln.

**Spielen:** https://bunwichtig.github.io/bombermannre/

## So spielt ihr zusammen

1. Einer öffnet die Seite, gibt Name, Raumname und Passwort ein und klickt **Raum erstellen**.
2. Die anderen öffnen dieselbe Seite, geben denselben Raumnamen und dasselbe Passwort ein und klicken **Raum beitreten**.
3. Der Gastgeber klickt **Spiel starten**. Sein Browser berechnet das Spiel und muss offen bleiben.

Die Browser verbinden sich direkt miteinander (WebRTC über [PeerJS](https://peerjs.com)). Es gibt keinen eigenen Server.

## Regeln

- Pfeiltasten oder WASD zum Laufen, Leertaste oder Enter für eine Bombe, Strg zündet Fernzünder-Bomben. Auf dem Handy gibt es Tasten.
- Bomben explodieren nach 2,5 Sekunden als Kreuz, sprengen Kisten und lösen andere Bomben aus.
- Wer vom Feuer getroffen wird, ist für die Runde raus. Wer zuerst die eingestellte Zahl an Runden gewinnt (Standard 3), gewinnt das Spiel.
- Power-ups aus Kisten: 💣 eine Bombe mehr, 🔥 größere Explosion, 👟 schneller laufen, 🦶 Bomben wegkicken.
- **Mega-Items** (Anteil einstellbar) mit bunt leuchtendem Rahmen: 🌟 Megafeuer (maximale Explosion, eine Bombe mehr), 💥 Durchschlag (Explosionen gehen durch Kisten), 🛡️ Schild (übersteht einen Treffer), 👻 Geist (10 Sekunden durch Kisten und Bomben laufen), 📡 Fernzünder (Bomben gehen erst auf Strg hoch, spätestens nach 20 Sekunden).
- Ecken-Hilfe: Wer knapp an einer Abzweigung vorbei ist oder vor einer Ecke steht, rutscht automatisch in den freien Gang.

## Einstellungen (Gastgeber, in der Lobby)

Zuerst wählt der Gastgeber den **Spielmodus**:

- **Klassisch:** feste Regeln (3 Rundensiege, 30 % Power-ups, keine Mega-Items). Wählbar sind 4, 5 oder 6 Spieler. Das Feld ist 15 × 13 bei 4, 17 × 13 bei 5 und 19 × 15 bei 6 Spielern. Spieler 5 und 6 starten oben und unten in der Mitte.
- **Individuell:** alle folgenden Einstellungen frei wählbar, dazu 2 bis 6 Spieler.

- **Spielvariante:** Klassisch oder Schrumpfendes Feld. Bei Letzterem fallen ab 1:00 Restzeit von außen nach innen Blöcke, wer darunter steht, ist raus.
- **Feldgröße:** Klein (11 × 9), Mittel (15 × 13), Groß (19 × 15), Riesig (23 × 17).
- **Power-up-Chance:** 0 bis 100 % pro gesprengter Kiste.
- **Rundensiege zum Gewinnen:** 1 bis 5.
- **Anteil Mega-Items:** 0 bis 100 % der Power-ups (Standard 10 %). Bei 0 % gibt es keine, bei 100 % nur Mega-Items.
  Aufklappbar „Mega-Items einzeln einstellen“: Gewichtung jedes Mega-Items von 0 (aus) bis 100, mit Anzeige, wie viel Prozent der Power-ups das ergibt.

## Sound

Alle Geräusche (Bombe legen, Explosion, Power-up, Treffer, Rundenstart, Sieg, Countdown in den letzten 10 Sekunden) werden direkt im Browser erzeugt.
Unter dem Spielfeld lässt sich der Ton aus- und einschalten.

## Rangliste

Auf der Startseite steht eine Rangliste mit Siegen, gespielten Spielen und gewonnenen Runden.
Ein Spiel zählt, sobald jemand die eingestellten Rundensiege erreicht hat. Gespeichert wird im Browser (localStorage).
Beim Beitreten tauschen Gastgeber und Mitspieler ihre Spiele aus, so haben alle denselben Stand.
Spieler werden über ihren Namen zugeordnet, also immer denselben Namen benutzen.

## Lokal testen

```sh
python -m http.server 8000
```

Dann `http://localhost:8000/?local` in zwei Tabs öffnen. Mit `?local` laufen die Tabs ohne Internet über den Browser selbst.

## Technik für andere Spiele

Wie der Online-Mehrspielermodus funktioniert und wie man ihn in ein anderes Spiel einbaut, steht in [docs/online-multiplayer.md](docs/online-multiplayer.md).
