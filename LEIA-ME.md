# Ghost Lady — site

## Arrancar no computador
```
node server.mjs
```
Abre http://localhost:5173 (só precisa do Node, sem `npm install`).

## O que está onde
- `ghost-lady/` — o site exportado do Manus (não mexer em `assets/`).
- `server.mjs` — servidor que substitui a API do Manus.
- `data/` — o que os visitantes deixam: `guestbook.json`, `visitors.json`, `messages.json` (formulário de contacto), `spotify.json`.
- `fallback-images/` — imagens substitutas para as que ficaram no Manus. Se tiveres as originais,
  põe-nas em `ghost-lady/manus-storage/` com o mesmo nome (ex.: `ghost-castle-moon_dff7242b.jpg`).

## Online no Render (grátis)
O site está em **https://ghost-lady.onrender.com** (painel: dashboard.render.com → ghost-lady).

Para publicar alterações: envia-as para o GitHub (`git push`) e, no Render, carrega em
**Manual Deploy → Deploy latest commit**. Para ser automático, liga a conta do GitHub ao Render
(Account Settings → Git) e ativa o Auto-Deploy no serviço.

O plano grátis adormece o servidor depois de 15 min sem visitas (a primeira visita seguinte demora ~1 minuto)
e **apaga a pasta `data/` em cada reinício**. Para não perderes os desenhos e o contador, usa o Upstash:

### Guardar os dados (Upstash, grátis)
1. Cria uma base de dados Redis em https://console.upstash.com
2. Copia o `UPSTASH_REDIS_REST_URL` e o `UPSTASH_REDIS_REST_TOKEN` (separador "REST API").
3. No Render: o teu serviço → **Environment** → preenche essas duas variáveis → guardar.

## Livro de visitas (moderação)
Os desenhos ficam pendentes até serem aprovados.
- No computador: http://localhost:5173/guestbook/moderation
- Online: `https://<o-teu-site>/guestbook/moderation?key=<ADMIN_KEY>`
  (o Render gera a `ADMIN_KEY` sozinho; vês o valor em **Environment**).

## Mensagens do formulário de contacto
Ficam em `data/messages.json` (e no Upstash, chave `ghostlady:messages`). Não é enviado email.

## Spotify ("a ouvir agora")
1. Cria uma app em https://developer.spotify.com/dashboard
2. Adiciona o Redirect URI: `https://<o-teu-site>/api/spotify/callback`
   (no computador: `http://127.0.0.1:5173/api/spotify/callback`).
3. Põe `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET` em **Environment** no Render.
4. Abre `https://<o-teu-site>/api/spotify/connect?key=<ADMIN_KEY>` e autoriza a tua conta.
   Sem o Upstash, esta ligação perde-se quando o servidor reinicia.
