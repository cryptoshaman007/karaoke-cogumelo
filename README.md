# 🍄 Karaokê Cogumelo

App web de karaokê para o bar. O cliente escaneia o QR code, digita o nome, busca uma música (só versões karaokê) e entra na fila, uma música por vez. O projetor mostra o vídeo do YouTube grande, a fila e o QR code. O admin aprova quem é novo, pula, reordena e configura o limite de duração.

## Telas

| Endereço | Quem usa | O que faz |
|---|---|---|
| `/` | PC do projetor | Vídeo grande, fila e QR para cantar. Antes de cada música mostra "Agora é a vez de…" com contagem. Pede a senha do admin uma vez. A engrenagem (canto inferior direito, quase invisível) mostra o QR do admin. |
| `/cantar` | Celular do cliente | Nome, busca, músicas mais cantadas, entrar na fila, ver a fila ao vivo, posição e tempo estimado de espera. O celular vibra quando chega a vez. |
| `/admin` | Celular do admin | Aprovar/recusar, pausar, reiniciar, pular, volume, reordenar, tocar em seguida, colocar alguém na fila, abrir/fechar a fila, recado no telão, limite de minutos, ligar/desligar aprovação. |

### Reações e campeonato

- **Reações:** enquanto alguém canta, o celular mostra quatro botões (👏 ❤️ 🔥 😭). Cada toque faz o emoji subir no telão. Limite de 8 reações a cada 10 segundos por pessoa. Liga e desliga em *Configurações* no admin.
- **Campeonato:** o admin liga em *Campeonato*. Enquanto estiver valendo, cada cliente dá uma nota de 1 a 5 (cinco carinhas) para quem está cantando, pode trocar até a música acabar e não vota em si mesmo. Os votos são secretos; só o admin vê a parcial. Ao encerrar, o telão e os celulares mostram a classificação e o vencedor (melhor média; empate decide quem teve mais votos). O vídeo fica parado enquanto o resultado está no telão.


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
- O celular do cliente lê a fila direto do Supabase (Realtime), sem ficar chamando o servidor da Vercel.
- O telão guarda o ponto da música: se a página recarregar ou o PC reiniciar, continua de onde parou.
- Votos e reações passam por funções do banco (`cast_vote`, `send_reaction`) chamadas só pelo servidor: uma ida ao banco por toque.
- Limite de tentativas no login do admin (8 erros em 15 min), nas entradas e nas buscas, guardado na tabela `rate_events`.

## Banco de dados

`supabase/schema.sql` cria o banco do zero. Depois rode, em ordem, os arquivos de `supabase/migrations/` (SQL Editor do Supabase). As migrações só adicionam coisas; o app funciona sem elas, mas as funções novas do admin (pausar, volume, recado, fila aberta/fechada) avisam que precisam da atualização.

## Rodar localmente

```bash
cp .env.example .env.local   # preencha SUPABASE_SECRET_KEY e ADMIN_PASSWORD
npm install
npm run dev
```
