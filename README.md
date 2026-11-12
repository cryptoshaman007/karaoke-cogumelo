# 🍄 Karaokê Cogumelo

App web de karaokê para o bar. O cliente escaneia o QR code, digita o nome, busca uma música (só versões karaokê) e entra na fila, uma música por vez. O projetor mostra o vídeo do YouTube grande, a fila e o QR code. O admin aprova quem é novo, pula, reordena e configura o limite de duração.

## Telas

| Endereço | Quem usa | O que faz |
|---|---|---|
| `/` | PC do projetor | Vídeo grande, fila e QR para cantar. Pede a senha do admin uma vez. A engrenagem ⚙ (canto inferior direito, quase invisível) mostra o QR do admin. |
| `/cantar` | Celular do cliente | Nome, busca, entrar na fila, ver a posição. |
| `/admin` | Celular do admin | Aprovar/recusar, pular, reordenar, limpar fila, limite de minutos, ligar/desligar aprovação. |

A fila fica salva no Supabase, então fechar o navegador ou desligar o PC não perde nada.

## Como colocar no ar (uma vez só)

1. **Supabase** (já criado: projeto `karaoke-cogumelo`, região São Paulo).
   Pegue a chave secreta em *Project Settings → API Keys → Secret keys* (ou a `service_role` em *Legacy API keys*).
2. **GitHub**: este código fica no repositório `karaoke-cogumelo`.
3. **Vercel** (vercel.com, entre com o GitHub) → *Add New → Project* → importe `karaoke-cogumelo` → em *Environment Variables* coloque:

   | Nome | Valor |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://tnltmuxkndicxvyeshzh.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_c1PgwaJUktSnKX8wpLpyrA_8hobWNFE` |
   | `SUPABASE_SECRET_KEY` | a chave secreta do passo 1 |
   | `ADMIN_PASSWORD` | uma senha forte só sua |

   Clique em *Deploy*. Em *Settings → Functions*, escolha a região **São Paulo (gru1)**.

## No bar

1. No PC com Windows, abra o Chrome no endereço da Vercel (ex.: `https://karaoke-cogumelo.vercel.app`).
2. Digite a senha do admin e clique em **Iniciar karaokê** (o navegador exige um clique para liberar o som).
3. Aperte **F11** para tela cheia.

## Detalhes técnicos

- Next.js 15 (App Router) + Supabase (Postgres + Realtime).
- Vídeo: player oficial do YouTube via iframe (sem chave).
- Busca: `youtubei.js` (sem chave e sem cota, mas não oficial). Fica isolada em `lib/youtube.ts` para trocar pela YouTube Data API se precisar.
- Segurança: o navegador só **lê** o banco. Toda escrita passa pelas rotas `/api/*` com a chave secreta. Cada cliente recebe um token salvo no celular.
- Regras no banco: uma música ativa por pessoa, uma tocando por vez, e a função `advance_queue` avança a fila com trava para evitar pulo duplo.

## Rodar localmente

```bash
cp .env.example .env.local   # preencha SUPABASE_SECRET_KEY e ADMIN_PASSWORD
npm install
npm run dev
```
