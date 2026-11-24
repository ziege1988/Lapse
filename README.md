# Lapse – Zeitraffer aus Fotos

Lapse macht aus einer Fotoserie ein ruhiges, flackerfreies Zeitraffer-Video – direkt im Browser auf dem iPhone, ohne Installation, ohne Upload, ohne Kosten.

1. **Fotos auswählen** – beliebig viele (sinnvoll: 30–500), sortiert nach Aufnahmezeit (EXIF) oder Dateiname.
2. **Automatisch ausrichten** – Lapse erkennt markante Bildpunkte, richtet jedes Foto exakt auf ein Referenzbild aus (Verschiebung, Drehung, Zoom, optional Perspektive), schneidet alle auf den größten gemeinsamen Bereich zu und gleicht Belichtung und Farbe an.
3. **Vorschau & Nachbessern** – Video in Echtzeit ansehen, Geschwindigkeit/Überblendung/Format einstellen, einzelne Fotos prüfen (Überlagern, Differenz, Blinken) und korrigieren.
4. **Exportieren** – MP4 (H.264/HEVC), WebM, GIF oder ausgerichtete JPEG-Einzelbilder (ZIP); direkt in die Fotos-App sichern oder teilen.

Alle Berechnungen laufen lokal auf dem Gerät. Die Originalfotos werden nur gelesen, nie verändert.

## Auf dem iPhone verwenden

1. Die App-Adresse in **Safari** öffnen (nach der Einrichtung: https://ziege1988.github.io/Lapse/ – siehe „Veröffentlichen & automatische Updates“).
2. Optional: Teilen-Symbol → **„Zum Home-Bildschirm“** – Lapse startet dann wie eine App im Vollbild und funktioniert auch offline.
3. „Fotos auswählen“ → in der Mediathek mehrere Fotos antippen (oder mit dem Finger über Fotos wischen) → „Hinzufügen“.
4. „Ausrichten & weiter“ → bearbeiten → „Weiter zum Export“ → „Video erstellen“ → **„In Fotos sichern / Teilen“ → „Video sichern“**.

Während eines längeren Exports App geöffnet und Bildschirm an lassen (Lapse verhindert die automatische Sperre, wo iOS das erlaubt).

**Empfohlen:** iOS 16.4 oder neuer (schnelle, bildgenaue Videokodierung über WebCodecs). Auf älteren Versionen nimmt Lapse das Video in Echtzeit auf (dauert so lange wie das Video selbst); GIF und ZIP funktionieren immer.

## Funktionen im Detail

### Ausrichtung
| Einstellung | Wirkung |
|---|---|
| Aufnahmeart **Stativ** | nur Verschiebung – am stabilsten bei fester Kamera |
| **Standard** | Verschiebung, Drehung, leichter Zoom – für die meisten Aufnahmen |
| **Freihand** | zusätzlich Perspektive – bei wechselndem Standpunkt |
| Genauigkeit **Präzise** | höhere Analyseauflösung und mehr Merkmale (ca. doppelte Zeit) |
| Referenzbild | erstes / mittleres / letztes Foto oder per Hand gesetzt |

Technik: Harris-Ecken auf einer Bildpyramide mit Subpixel-Verfeinerung, rotationsinvariante binäre Deskriptoren (helligkeitsunabhängig, robust bei Tag-Nacht-Übergängen), gegenseitiges Matching mit Ratio-Test, RANSAC/MSAC mit anschließender Ausgleichsrechnung. Gelingt die direkte Ausrichtung nicht, wird über das Nachbarfoto verkettet. In Tests liegt die Restabweichung bei unter 0,05 px (1080p).

### Automatische Qualitätskontrolle
- Fotos, die sich nicht sicher ausrichten lassen (anderes Motiv, Nebel, starke Unschärfe), werden **automatisch ausgeschlossen** und grau markiert – mit einem Tipp wieder aufnehmbar.
- Unsichere Ausrichtungen und **Sprünge** gegenüber Nachbarfotos werden markiert (⚠). „Auffällige präzise nachrechnen“ analysiert diese Fotos erneut in hoher Auflösung.
- Erkennt **Ausreißer, die den Bildausschnitt verkleinern** (z. B. versehentlich gezoomtes oder verdrehtes Foto), und schlägt vor, sie auszuschließen – mit Angabe, wie viel größer der Ausschnitt dann wäre.

### Nachbesserung einzelner Fotos
- Vergleich mit der Referenz: **Überlagern**, **Differenz** (helligkeitsnormiert – zeigt nur Versatz) und **Blinken**.
- Feinkorrektur von Position, Drehung, Größe sowie Belichtung, Farbtemperatur und Tönung je Foto.
- Präzise Neuausrichtung, Foto als Referenz setzen (exakte Umrechnung aller Fotos), ausschließen, als geprüft markieren.
- Nach jeder Änderung werden Zuschnitt, Helligkeitsmessung und Farbangleich für **alle** Fotos neu berechnet.

### Bild & Video
- Seitenverhältnis 16:9, 9:16, 4:3, 3:4, 1:1 oder Original; automatischer Zuschnitt ohne leere Ränder, optional zusätzlicher Zoom.
- Belichtung/Farbe angleichen: **Flackern entfernen** (zeitlich geglättet – natürliche Verläufe wie Sonnenuntergänge bleiben erhalten) oder **wie Referenz**; Stärke, Glättungsfenster, wahlweise inkl. Weißabgleich.
- Globale Belichtung, Kontrast, Sättigung.
- Fotos pro Sekunde, Bildrate (24/25/30/60), weiche Überblendung, Bewegungsglättung (Langzeitbelichtungs-Effekt), Bumerang, Standbild am Anfang/Ende.

### Export
| Format | Hinweis |
|---|---|
| MP4 · H.264 | empfohlen; läuft überall, auch in der Fotos-App |
| MP4 · HEVC | kleinere Datei; nur wenn das Gerät den Encoder anbietet |
| WebM · VP9 | für Web/Android |
| GIF | bis 720 px, 256 Farben |
| JPEG-Einzelbilder (ZIP) | ausgerichtet & angeglichen, zur Weiterverarbeitung (z. B. Lightroom) |

Auflösungen 720p bis 4K (je nach Encoder des Geräts). Der Export rechnet jedes Bild aus den **Originaldateien** neu – nicht aus den Vorschaubildern.

**Qualität & Dateigröße** (wirkt auf alle Formate):
- *Nach Qualität*: Regler von „Klein“ bis „Maximal“ mit Live-Anzeige von geschätzter Dateigröße und Datenrate. Bei GIF steuert er Farbanzahl und Bildrate, bei ZIP die JPEG-Qualität.
- *Nach Dateigröße* (Videos): Zielgröße per Regler oder Schnellwahl (8 / 16 / 25 / 50 / 100 / 250 MB) – die Datenrate wird so berechnet, dass das Video das Limit möglichst nicht überschreitet. Nach dem Export zeigt Lapse die tatsächliche Größe und ob das Ziel eingehalten wurde.
- Ist die Datenrate für die gewählte Auflösung zu niedrig (Blockbildung), schlägt Lapse eine passendere Auflösung vor – mit einem Tipp umstellbar.

## Veröffentlichen & automatische Updates (GitHub Pages, kostenlos)

Lapse besteht nur aus statischen Dateien. Der Workflow `.github/workflows/pages.yml` veröffentlicht bei **jedem Push** auf `main` oder einen `claude/…`-Branch automatisch: Tests → Versionsnummer (Commit) eintragen → auf GitHub Pages bereitstellen. Adresse: **https://ziege1988.github.io/Lapse/**

### Einmalige Einrichtung auf github.com
1. **Pages aktivieren:** Repository → *Settings* → *Pages* → *Build and deployment* → *Source*: **GitHub Actions** wählen (keinen Branch auswählen).
2. **Branches für die Veröffentlichung freigeben:** *Settings* → *Environments* → **github-pages** → *Deployment branches and tags* → *Add deployment branch or tag rule* → `claude/*` eintragen → *Add rule*; dasselbe für `main`. (Ohne diese Regeln darf nur der Standard-Branch veröffentlichen.)
3. **Actions erlauben** (meist schon so): *Settings* → *Actions* → *General* → *Actions permissions*: „Allow all actions and reusable workflows“.
4. **Erste Veröffentlichung starten:** Tab *Actions* → „Lapse veröffentlichen“ → *Run workflow* → Branch wählen → *Run workflow*. Nach 1–2 Minuten grüner Haken; die Adresse steht im Lauf und unter *Settings → Pages*.

### Wie Updates ankommen
- Jeder neue Push wird automatisch veröffentlicht (Status im Tab *Actions*).
- Die App prüft beim Öffnen, beim Zurückkehren in die App und alle 30 Minuten auf eine neue Version.
- **Kein Projekt geöffnet:** Lapse lädt die neue Version sofort selbst.
- **Projekt geöffnet:** Eine Leiste „Neue Lapse-Version ist da“ erscheint – „Jetzt laden“ oder „Später“. So geht keine Arbeit verloren.
- Die aktuelle Version (Commit · Datum) steht auf der Startseite unter dem Hinweistext.

Hinweis: Laufen mehrere Arbeits-Branches gleichzeitig, gewinnt der zuletzt veröffentlichte Stand. Wer nur geprüfte Versionen live haben möchte, entfernt `'claude/**'` aus `on.push.branches` im Workflow und veröffentlicht nur über `main`.

Lokal testen: `python3 -m http.server 8000` im Projektordner, dann `http://localhost:8000` öffnen (Anzeige „Entwicklungsversion“; `file://` funktioniert wegen Modulen/Worker nicht).

## Projektstruktur

```
index.html            Oberfläche
css/app.css           Gestaltung (mobil zuerst, Safe-Area für iPhone)
js/app.js             Steuerung der Oberfläche
js/project.js         Projektmodell: Transformationen, Zuschnitt, Farbangleich, Zeitplan, Qualität
js/pipeline.js        Import, Analyse, Ausrichtung, Messung, präzise Nachberechnung
js/features.js        Merkmalserkennung und Matching
js/geometry.js        Matrizen, Modellschätzung, RANSAC, größtes Rechteck
js/align-worker.js    Web Worker für die rechenintensive Analyse
js/renderer.js        WebGL: Entzerrung, Farbe, Überblendung (Vorschau = Export)
js/player.js          Vorschau-Player
js/export.js          WebCodecs-Export (MP4/WebM), GIF, ZIP, Echtzeit-Rückfall
js/images.js, exif.js, zip.js   Hilfsfunktionen
vendor/               mp4-muxer, webm-muxer, gifenc (MIT, Lizenzen in vendor/licenses)
sw.js, manifest.webmanifest, icons/   Offline-Fähigkeit, Updates und Home-Bildschirm-App
js/version.js         Versionskennung (wird beim Veröffentlichen eingetragen)
.github/workflows/    automatische Veröffentlichung auf GitHub Pages
tests/                Geometrie-/Ausrichtungstest (Node) und Browser-Gesamttest (Playwright)
```

Tests: `node tests/align.test.mjs` und `node tests/e2e.cjs` (benötigt Playwright mit Chromium).

## Bekannte Grenzen

- **Speicher:** Im Arbeitsspeicher liegen nur kleine Vorschaubilder; trotzdem kann iOS den Tab bei sehr vielen Fotos oder im Hintergrund neu laden – dann ist das Projekt verloren (noch keine Speicherung des Projekts).
- **HEIC:** Die iOS-Fotoauswahl liefert Fotos in der Regel als JPEG. Falls doch HEIC ankommt, dekodiert Safari es ab iOS 17; ältere Versionen können solche Dateien ablehnen.
- **Aufnahmezeit** wird aus JPEG-EXIF gelesen. Fehlt sie bei einzelnen Fotos, sortiert Lapse nach Dateiname.
- Starke Bewegungen im Bild (Menschenmengen, Wellen) bei wenig fester Struktur können die Ausrichtung erschweren – dann „Präzise“ oder Aufnahmeart „Stativ“ wählen.
