# Deploy na Vercel

## Por que deu "not found"
A Vercel não roda um servidor Node "tradicional" (tipo aquele `server.js` que
te passei antes, com `http.createServer(...).listen(...)`). Ela só entende:

- Arquivos estáticos na raiz (o `index.html`)
- **Funções serverless** dentro da pasta `api/` — um arquivo por rota

Por isso o `/api/data` dava 404: não existia nenhuma function nesse caminho.
Nesta pasta já está no formato certo: `api/data.js` exporta a function que a
Vercel espera.

## Passo 1 — Configurar as variáveis de ambiente (isso é o que geralmente falta)
O `.env` **não funciona em produção na Vercel** — ele só vale localmente
(`vercel dev`). Em produção você precisa cadastrar as variáveis no painel:

**Vercel → seu projeto → Settings → Environment Variables**

| Nome | Valor |
|---|---|
| `META_ACCESS_TOKEN` | seu token da Meta (veja aviso abaixo) |
| `META_AD_ACCOUNT_ID` | `762597382480878` |
| `META_API_VERSION` | `v20.0` (opcional) |
| `SHEET_ID` | `1MW_dyf0VOHULceCCtY7FkCR_tLCCkM6YqPY-TQd8fjI` (opcional, já é o default) |
| `SHEET_GID` | `1467696356` (opcional, já é o default) |

Depois de adicionar, **é preciso refazer o deploy** (Vercel não aplica env vars
em deploys já feitos): `vercel --prod` de novo, ou "Redeploy" no painel.

## Passo 2 — Deploy
```bash
npm i -g vercel   # se ainda não tiver
cd dashboard-funis-vercel
vercel            # primeira vez: cria o projeto
vercel --prod     # publica de vez
```

## Passo 3 — Testar
Depois do deploy, abra:
```
https://SEU-PROJETO.vercel.app/api/data?range=7 dias
```
Se aparecer JSON com `kpis`/`leadsList`, está funcionando. Se aparecer
`{"error": "..."}`, a mensagem já diz o motivo (token expirado, conta de
anúncios errada, planilha não pública, etc.) — bem mais fácil de debugar que
um "not found" genérico.

Depois abra `https://SEU-PROJETO.vercel.app/` — o dashboard já busca os dados
em `/api/data` automaticamente (mesmo domínio, não precisa editar nada no HTML).

## Se ainda der "not found"
Confirma o seguinte, nessa ordem:
1. A pasta enviada para a Vercel tem `index.html` **na raiz** (não dentro de
   uma subpasta)?
2. Existe mesmo uma pasta `api/` com `data.js` dentro, na raiz do projeto?
3. Foi feito o **redeploy** depois de adicionar as env vars?
4. A URL testada é `/api/data` (com `s` em "data", sem barra extra no final)?

## Segurança
- Gere um **token de Sistema (System User)** com permissão `ads_read` em
  business.facebook.com → Usuários do Sistema — ele não expira, diferente do
  token de usuário comum que você colou aqui.
- Nunca coloque o token direto no código — sempre via env vars da Vercel.
