# RTV 365 Stremio/Nuvio dodatek (Cloudflare Workers)

Neuradni dodatek za [RTV 365](https://365.rtvslo.si/) (RTV Slovenija). Prijava ni potrebna.

Katalogi:
- **RTV 365 Slovenski filmi** – https://365.rtvslo.si/raziskuj?&WPId=335&c=show (oddaja "Slovenski filmi", id 236)
- **RTV 365 Slovenske serije** – https://365.rtvslo.si/oddaje/seznam/339?group=show_covers&imageType=thumbnail&clip=show&page=serije

Iskanje v katalogu deluje po naslovu (znotraj naloženega kataloga). Serije prikažejo epizode iz API-ja oddaje
(številka epizode se prebere iz naslova, npr. "Smrdljivc, 6/6"; če se številka vrne na začetek, se začne nova sezona).

## Namestitev na Cloudflare

Ime v `wrangler.jsonc` (`"name": "rtv365nuvioaddon"`) se **mora ujemati** z imenom projekta/Workerja v Cloudflare,
sicer build spodleti. Če želite drugo ime, spremenite obe mesti.

### A: GitHub repozitorij (Workers Builds)
1. Workers & Pages → **Create** → **Import a repository**.
2. Ime projekta: `rtv365nuvioaddon`. Build command: prazno. Deploy command: `npx wrangler deploy`.

### B: ukazna vrstica
```bash
npm install
npx wrangler login
npx wrangler deploy
```

Nato odprite `https://rtv365nuvioaddon.<poddomena>.workers.dev/` → **NAMESTI** (Stremio) ali kopirajte
povezavo `/manifest.json` v Nuvio.

Lokalno: `npm run dev`.

## Kako deluje predvajanje
RTV 365 vrača predvajalne povezave z žetonom (`keylockhash`) in preverja, da je User-Agent pri API klicu enak kot
pri pretakanju. Zato Worker sam kliče API (`getRecordingDrm` → `getMedia`) in sam pretaka video (`/play/…`, za HLS tudi
`/hls/…`) z istim User-Agentom. Priporočeni so mp4 viri (podpirajo premikanje po videu); HLS je rezerva.

## Spremenljivke (`wrangler.jsonc` → `vars`)
`RTV_CLIENT_ID`, `MOVIES_URL`, `MOVIES_SHOW_ID`, `SERIES_URL`, neobvezno `PUBLIC_URL`.

## Omejitve
- Del vsebine je lahko geo-omejen (npr. samo za Slovenijo) ali plačljiv (Filmoteka); take posnetke Worker ne more predvajati.
- Predpomnilnik živi v pomnilniku Workerja in se ob hladnem zagonu izprazni.
- Brezplačni plan: 100.000 zahtevkov/dan; vsak Range zahtevek in vsak HLS segment je en zahtevek.
- Podnapisov ta različica ne vključuje.
