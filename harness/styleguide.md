# GoodChat — Style Guide (extraído do projeto Portfolio)

**Fonte:** `~/desktop/good/Portfolio` (Next.js 16 + Tailwind CSS v4 + daisyUI 5).
Todos os valores abaixo foram lidos diretamente do código-fonte do Portfolio — nenhum valor foi inventado ou aproximado. Arquivos de origem citados em cada seção.

---

## 1. Nome do tema

O Portfolio chama sua unidade visual de **skin**. Existem duas:

| Skin | Rotas | Caráter (descrição oficial em `docs/skins.md`) |
|---|---|---|
| **`retro`** | `/`, `/ti`, `/ti/cv` | **Neobrutalist** — cantos retos, bordas de 2px, sombras duras deslocadas (hard offset shadows), tipografia itálica superdimensionada |
| `terminal` | `/dev`, `/dev/cv` | Shell/CRT — bordas 1px, micro-tipografia monoespaçada, glow no accent, overlay de scanline |

O nome exato da skin de referência para o GoodChat é **`retro`** (valor de `data-skin`, pasta `src/components/retro/`, entrada `id: "retro"` em `src/data/theme-config.ts`). Seus temas daisyUI se chamam **`retro-hub-light`**, **`retro-hub-dark`**, **`retro-ti-light`**, **`retro-ti-dark`** (`src/styles/themes.css`).

> Observação: a skin `retro` é "híbrida" — a página hub (`src/app/page.tsx`) renderiza também o overlay `terminal-scanline` com `opacity-10`, comentado no código como *"Background Terminal Scanline (Hybrid)"*. Ou seja, o scanline não é exclusivo da skin terminal.

---

## 2. Cores

### 2.1 Paleta bruta (`src/styles/palettes.css`)

Regra do Portfolio: **uma cor existe uma única vez**, como `--palette-*` em `:root`. Nenhum hex fora desse arquivo (única exceção: `THEME_COLOR_LIGHT/DARK` em `theme-config.ts`, por limitação da tag `<meta theme-color>`).

Subconjunto usado pelos temas `retro`:

| Token | Hex | Papel |
|---|---|---|
| `--palette-cream` | `#f2efe7` | Fundo claro (base-100 light) |
| `--palette-white` | `#ffffff` | Superfície elevada light / conteúdo sobre accent |
| `--palette-ink` | `#1a0a0a` | Texto/bordas no light (base-content, base-300) |
| `--palette-noir` | `#121212` | Fundo escuro hub (base-100 dark) |
| `--palette-noir-raised` | `#1a1a1a` | Superfície elevada dark hub (base-200) |
| `--palette-near-black` | `#0d0d0d` | Texto sobre cores de status soft (dark) |
| `--palette-crimson` | `#dc143c` | **Accent/primary do retro light** |
| `--palette-rose` | `#e8729a` | **Accent/primary do retro-hub-dark** |
| `--palette-ember` | `#ff6b45` | Accent do retro-ti-dark; hover ti no hub dark |
| `--palette-gold` | `#c8a96e` | Hover dev no hub dark |
| `--palette-midnight` | `#0d1117` | Fundo dark ti (base-100) |
| `--palette-midnight-raised` | `#121a12` | Superfície elevada dark ti (base-200) |
| `--palette-mint` | `#e0ffe0` | Texto dark ti (base-content) |
| `--palette-abyss` | `#0a0f1e` | Hover dev no hub light |

Cores de status (duas forças: cheia para temas light, suavizada para dark):

| Semântica | Light | Dark (soft) |
|---|---|---|
| info | `#2563eb` | `#60a5fa` |
| success | `#16a34a` | `#4ade80` |
| warning | `#d97706` | `#fbbf24` |
| error | `#dc2626` | `#f87171` |

Overlays: `--palette-scanline-light: rgba(0,0,0,0.05)` · `--palette-scanline-dark: rgba(0,0,0,0.2)`.

### 2.2 Mapeamento nos temas daisyUI (`src/styles/themes.css`)

Os quatro temas retro completos (valores resolvidos):

| Token daisyUI | retro-hub-light | retro-hub-dark | retro-ti-light | retro-ti-dark |
|---|---|---|---|---|
| `base-100` (página) | cream `#f2efe7` | noir `#121212` | cream `#f2efe7` | midnight `#0d1117` |
| `base-200` (elevado) | white `#ffffff` | noir-raised `#1a1a1a` | white | midnight-raised `#121a12` |
| `base-300` (bordas) | ink `#1a0a0a` | cream `#f2efe7` | ink | ember `#ff6b45` |
| `base-content` (texto) | ink `#1a0a0a` | cream `#f2efe7` | ink | mint `#e0ffe0` |
| `primary` = `accent` | crimson `#dc143c` | rose `#e8729a` | crimson | ember `#ff6b45` |
| `primary/accent-content` | white | white | white | white |
| `secondary` | ink | cream | ink | mint |
| `neutral` | ink | cream | ink | mint |
| `--shadow` (extra) | ink | rose | ink | ember |
| `--scanline-color` (extra) | scanline-light | scanline-dark | scanline-light | scanline-dark |

Extras exclusivos do hub: `--hub-dev-hover` (abyss / gold) e `--hub-ti-hover` (crimson / ember) — cores de hover dos cards de persona; não relevantes para o GoodChat.

**Padrão notável:** no dark, a cor da borda (`base-300`) vira a cor clara do texto (cream/ember) — bordas fortes e visíveis nos dois modos, nunca cinza sutil.

---

## 3. Tipografia

**Uma única família para tudo: JetBrains Mono** (arquivos woff2 locais em `src/assets/fonts/`, carregados via `next/font/local` em `src/app/layout.tsx`). Em `globals.css`, tanto `--font-sans` quanto `--font-mono` apontam para `--font-jetbrains-mono` — não existe fonte "sans" separada; o monoespaçado universal é parte central do feel retro.

- **Pesos disponíveis:** 400 (Regular), 500 (Medium), 700 (Bold), 800 (ExtraBold), todos com itálico.
- ⚠️ O código usa `font-black` (peso 900) extensivamente, mas a face mais pesada declarada é 800 — o browser resolve para 800 (ou sintetiza). Documentado aqui para não "corrigir" sem querer: o rendering que o autor aprovou é esse.
- `preload: false` no next/font (evita 1.1MB de fontes render-blocking); `display: swap`; `antialiased` no body.

### Escala e tratamentos observados (componentes retro)

| Uso | Classes |
|---|---|
| Título de seção (assinatura da skin) | `text-4xl sm:text-5xl md:text-8xl font-black tracking-tighter italic underline decoration-accent decoration-4 md:decoration-8 underline-offset-4 md:underline-offset-8 uppercase` |
| H1 hero | `text-4xl sm:text-5xl md:text-6xl xl:text-7xl font-black leading-[1.05–1.1] tracking-tighter uppercase` |
| Corpo | `text-base sm:text-lg md:text-xl font-medium leading-relaxed`, cor `text-base-content/70` |
| Eyebrow/label | `font-mono text-accent font-bold uppercase tracking-widest text-xs sm:text-base` (com prefixo literal `">"`) |
| Tag de projeto | `text-[10px] md:text-xs font-black uppercase tracking-widest` |
| Micro-texto decorativo (status/footers) | `text-[8px] md:text-[10px] uppercase tracking-[0.2em]` com `opacity-30`–`40` |

Padrões-chave: **UPPERCASE em quase tudo que não é corpo**, `tracking-tighter` em títulos grandes, `tracking-widest`/`tracking-[0.2em]` em micro-labels, itálico como recurso de destaque, `font-black`/`font-bold` dominantes.

---

## 4. Efeitos e motifs retrô (o que EXISTE de verdade)

Confirmados no código da skin `retro` (`src/styles/retro.css`, componentes):

1. **Sombra dura deslocada (hard offset shadow)** — assinatura nº 1 da skin:
   - `.retro-shadow` → `box-shadow: 6px 6px 0 0 var(--shadow)`
   - `.retro-shadow-sm` → `box-shadow: 3px 3px 0 0 var(--shadow)`
   - Sem blur, sem spread; cor vem do token `--shadow` do tema.
2. **Bordas grossas retas** — `.retro-border` → `border: var(--frame-border) solid var(--color-base-300)` com `--frame-border: 2px`.
3. **Zero border-radius** — todos os temas: `--radius-selector/field/box: 0rem`. Cantos 100% retos (exceções deliberadas: anéis/avatares circulares no hero ti).
4. **Scanline CRT** (`.terminal-scanline`, definida em `terminal.css` mas usada também no hub retro com `opacity-10`): gradiente horizontal repetido a cada 4px com `--scanline-color`, `position: fixed`, `pointer-events: none`, opacity 0.3 base.
5. **Cursor piscando** (`.terminal-cursor` + `@keyframes blink` 1s step-end) — usado no `TypingText` compartilhado e na skin terminal. Disponível para o GoodChat (composer, indicador de digitação).
6. **Texto estilo terminal decorativo** — prefixo `">"` em eyebrows, micro-textos tipo `Session: active` / `Access: full_root`, footer de status com `ENC: AES-256-GCM`, coordenadas, string de build (`DG_OS_V1.0`).
7. **WindowDots** — três circulos estilo janela de SO: `bg-accent`, `bg-base-300`, `bg-base-300`.
8. **Canto decorativo** — quadrado `bg-accent` rotacionado 45° estourando o canto do card (hero ti).
9. **Anéis decorativos girando** — bordas dashed `border-accent/20` com `animate-[spin_40s_linear_infinite]` (movimento ambiente contínuo, lento).
10. **Seleção de texto temática** — `selection:bg-accent selection:text-accent-content`.
11. **Tooltip retro** (`.tooltip-retro`) — daisyUI tooltip achatado: borda 2px, uppercase 10px/900, `letter-spacing: 0.1em`, sem seta, radius 0, fundo accent.
12. **Foco visível global** — `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px }`.
13. **`prefers-reduced-motion`** respeitado: mata animações e esconde o scanline.

**NÃO existem na skin retro** (não inventar): glow de texto (`terminal-glow` é só da skin terminal), curvatura/vignette CRT, dithering, glitch, pixel fonts (a fonte é JetBrains Mono, não bitmap), bordas pixel-stepped.

### Motion (framer-motion 12)

- Entradas: fade + slide sutil — `initial={{ opacity: 0, y: 30 }}` → `animate={{ opacity: 1, y: 0 }}`, `transition={{ duration: 0.6 }}`. Sem spring, sem overshoot.
- Hover interativo: `-translate-y-1` + sombra cresce (`retro-shadow-sm` → `retro-shadow`); `active:translate-y-0` (pressiona de volta). `transition-all duration-300`.
- Movimento ambiente: spins lentos (20–40s), cursor piscando.
- Existe um `animate-bounce` pontual num card decorativo de Projects (seta "→"). É movimento ambiente contínuo, não entrada — **para o GoodChat, não usar** (regra do time: nada de bounce; preferir os padrões acima).

---

## 5. Espaçamento, geometria e sombras (tokens)

| Token (todos os temas retro) | Valor |
|---|---|
| `--radius-selector` / `--radius-field` / `--radius-box` | `0rem` |
| `--border` (controles daisyUI) | `2px` (skin terminal usa 1px) |
| `--frame-border` (molduras `.retro-border`) | `2px` |
| `--size-selector` / `--size-field` | `0.25rem` |
| `--depth` / `--noise` | `0` |
| Sombra padrão / pequena | `6px 6px 0 0` / `3px 3px 0 0` |

Convenções de espaçamento observadas (escala Tailwind padrão, sem customização):
- Padding de cards/painéis: `p-6 sm:p-8 md:p-12` (hero chega a `lg:p-16`); tiles menores `p-4`–`p-6`.
- Gaps de grid: `gap-3 sm:gap-4` (compacto), `gap-4 md:gap-6` (padrão), `gap-12 lg:gap-16` (seções).
- Margens de título de seção: `mb-12 md:mb-20`.

---

## 6. Referência de componentes (tratamentos → equivalentes GoodChat)

### Botões (`src/styles/retro.css` — variantes via tokens do `btn` daisyUI)

| Variante | Tokens | Uso GoodChat |
|---|---|---|
| `btn-retro` | fundo accent, texto accent-content, altura `3.25rem` (md: `3.75rem`), padding-x `2rem`, fonte `0.875rem`→`1rem`, borda base-300, `font-weight: 900`, uppercase | CTA primário (Login, Enviar) |
| `btn-retro-outline` | fundo transparente, texto base-content, mesma geometria | Ação secundária |
| `btn-retro-invert` | fundo base-content, texto base-100, altura `2.75rem`→`3rem`, fonte `0.75rem`→`0.875rem` | Ações compactas |

Padrão importante: variantes estendem o `btn` do daisyUI **pelos tokens dele** (`--btn-color`, `--btn-fg`, `--btn-p`, `--size`, `--fontsize`) — o `btn` continua fornecendo focus/active/disabled. Replicar essa técnica no GoodChat (ex.: `btn-goodchat`).

### Card / Painel (`RetroCard`)

`card card-border border-base-300 bg-base-200` + `retro-shadow` (ou `-sm`, ou nenhuma). Cantos retos vêm do tema. → Base para: painel de conversa, modais, container de login.

### Badges (`RetroBadge`)

Base `badge h-auto gap-0 border-base-300`; variantes `accent` (bloco accent uppercase 900), `chip` (nome bold sobre base-100), `tag` (10px, 900, `tracking-widest`). → Contador de não lidas, timestamps, labels de estado.

### Tiles interativos (RetroSocialLinks)

`retro-border bg-base-200` + hover `bg-accent text-accent-content -translate-y-1` + sombra sm→md + `active:translate-y-0`. → Padrão perfeito para itens da lista de conversas.

### Composição para o GoodChat (novos, na mesma família)

- **Bolha de mensagem:** daisyUI `chat` + `chat-bubble` herdará radius 0 e cores do tema; recebida = `bg-base-200` + `retro-border`, enviada = `bg-accent text-accent-content` + `retro-border`; `retro-shadow-sm`. Metadados (hora/status) em micro-texto `text-[10px] font-mono uppercase opacity-40`.
- **Composer:** campo com `retro-border`, fundo `base-200`, radius 0; cursor/caret pode usar o motif `terminal-cursor`. Atenção: o Portfolio **exclui** o componente `input` do daisyUI (ver §7); decidir no GoodChat entre incluí-lo ou estilizar campo próprio.
- **Indicador de digitação:** micro-texto uppercase + cursor piscando (motif nº 5) em vez de três bolinhas saltitantes.
- **Cabeçalho de conversa:** padrão `ModuleHeader` do terminal (`bg-accent/10 border-b border-accent/20`, label `[ NOME ]`) é opcional; alternativa retro: barra com `retro-border` + WindowDots.

---

## 7. Mapeamento para tema daisyUI custom no GoodChat

**Importante:** o Portfolio usa **Tailwind v4 + daisyUI 5 — não existe `tailwind.config.js`**; tudo é CSS-first. O approach "via `daisyui.themes` no `tailwind.config`" citado no kickoff é o formato antigo (Tailwind v3/daisyUI 4). Recomendação: **replicar o formato CSS-first do Portfolio** (verificar docs atuais do daisyUI na hora da implementação, conforme `inicial.md` exige).

Receita:

```css
/* app/src/index.css */
@import "tailwindcss";
@plugin "daisyui" {
  themes: false; /* só os temas custom; evita 35 temas mortos e typos silenciosos */
  logs: false;
}

/* palettes.css — copiar os --palette-* usados (seção 2.1) */

@plugin "daisyui/theme" {
  name: "goodchat-light";
  default: true;
  color-scheme: light;
  /* copiar bloco retro-hub-light integralmente (seção 2.2), inclusive:
     --radius-*: 0rem; --border: 2px; --depth: 0; --noise: 0;
     --shadow: var(--palette-ink); --scanline-color: var(--palette-scanline-light);
     --frame-border: 2px; */
}

@plugin "daisyui/theme" {
  name: "goodchat-dark";
  color-scheme: dark;
  /* copiar retro-hub-dark; declarar DEPOIS do light (regra de cascata::root) */
}
```

Regras herdadas do Portfolio que valem para o GoodChat:

1. **Cor existe uma vez** — hex só em `palettes.css`; temas referenciam `var(--palette-*)` (daisyUI aceita `var()` nos tokens, validado pelo Portfolio).
2. **Primeiro tema é `default: true` e cai no `:root`** — os demais vêm depois no arquivo.
3. **Extras por tema:** `--shadow` e `--scanline-color` sempre; `--frame-border` uma vez no primeiro tema.
4. **Utilities como `@utility`:** portar `retro-shadow`, `retro-shadow-sm`, `retro-border`, `tooltip-retro`, `terminal-scanline` (opcional, overlay `opacity-10`), `terminal-cursor` + `@keyframes blink`; criar variantes `btn-goodchat*` via tokens do `btn`.
5. **`themes: false`** no plugin; considerar `exclude` de componentes não usados (técnica do Portfolio; o guard script `check-excluded.mjs` é opcional).
6. Body: `background: var(--color-base-100)`, transição suave de cores (0.3s ease), `:focus-visible` accent, bloco `prefers-reduced-motion`.
7. Fonte: copiar os woff2 de JetBrains Mono (OFL — pode) ou instalar `@fontsource/jetbrains-mono`; alias `--font-sans` e `--font-mono` para ela.

Base recomendada: **par `retro-hub-light` / `retro-hub-dark`** (cream/crimson · noir/rose) — é o par default do Portfolio e o de maior identidade. Ver ambiguidade nº 1 abaixo.

---

## 8. Ambiguidades / decisões pendentes

1. **Qual par dark?** `retro-hub-dark` (noir `#121212` + rose `#e8729a`) e `retro-ti-dark` (midnight `#0d1117` + ember `#ff6b45` + texto mint) divergem. Recomendo o par **hub** (é o default e o "rosto" do site); confirmar com o usuário.
2. **`font-black` (900) vs. face máxima 800** — comportamento herdado do Portfolio (browser resolve para 800/sintetiza). Manter igual ou padronizar em `font-extrabold`? Recomendo manter classes idênticas às do Portfolio.
3. **Scanline no GoodChat** — o hub usa `terminal-scanline opacity-10` sobre a skin retro ("hybrid"). Sugiro incluir (barato, muito característico), mas é opcional; respeitar `prefers-reduced-motion`.
4. **Componente `input` do daisyUI** — excluído no Portfolio por razões próprias da skin terminal. GoodChat tem formulários reais (login, composer); provavelmente **incluir** e estilizar via tema (radius 0 + borda 2px já vêm dos tokens). Decidir na implementação.
5. **Nome do tema no GoodChat** — tokens aqui propostos como `goodchat-light`/`goodchat-dark` (derivados de `retro-hub-*`). Alternativa: manter os nomes `retro-hub-*` literais. Proposta: nomes próprios, origem documentada aqui.

Nada além disso ficou sem fonte clara — todos os valores têm arquivo de origem citado.
