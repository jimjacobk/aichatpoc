/**
 * DB Assistant Chat Widget — Floating Balloon Edition
 * Self-contained React component. No build step required.
 *
 * Usage:
 *   <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
 *   <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
 *   <script src="chat-widget.js"></script>
 *   <script>
 *     DBChatWidget.init({
 *       backendUrl:  'http://localhost:8000',
 *       title:       'Data Assistant',
 *       position:    'bottom-right',    // 'bottom-right' | 'bottom-left' | 'bottom-center'
 *       offset:      { x: 24, y: 24 }, // distance from viewport edge in px
 *       balloonIcon: '🗄️',              // emoji shown on the balloon button
 *       accentColor: '#4f8ef7',         // primary accent colour (hex)
 *       placeholder: 'Ask about your data…',
 *       suggestions: [
 *         'How many customers do we have?',
 *         'Top 5 products by revenue',
 *       ],
 *     });
 *   </script>
 */

(function (global) {
  "use strict";

  const { React, ReactDOM } = global;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;

  /* ─────────────────────────────────────────────────────────────────────────
     Styles
  ───────────────────────────────────────────────────────────────────────── */
  const STYLES = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap');

    .dbc-wrap *, .dbc-wrap *::before, .dbc-wrap *::after {
      box-sizing: border-box; margin: 0; padding: 0;
    }

    /* ── Balloon launcher ─────────────────────────────────────── */
    .dbc-launcher {
      position: fixed;
      z-index: 99998;
      width: 58px; height: 58px;
      border-radius: 50%;
      background: var(--dbc-accent, #4f8ef7);
      border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 24px rgba(0,0,0,.4);
      transition: transform .2s cubic-bezier(.34,1.56,.64,1), box-shadow .2s;
      outline: none;
    }
    .dbc-launcher:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 32px rgba(0,0,0,.45), 0 0 0 7px rgba(79,142,247,.15);
    }
    .dbc-launcher:active  { transform: scale(.95); }

    .dbc-launcher-inner {
      position: relative; width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
    }
    .dbc-l-icon, .dbc-l-close {
      position: absolute;
      transition: opacity .18s ease, transform .22s cubic-bezier(.34,1.56,.64,1);
    }
    .dbc-l-icon  { font-size: 22px; opacity: 1; transform: scale(1) rotate(0deg); }
    .dbc-l-close { font-size: 20px; color: #fff; opacity: 0; transform: scale(.4) rotate(-90deg); font-family: sans-serif; font-weight: 300; line-height: 1; }

    .dbc-launcher.dbc-open .dbc-l-icon  { opacity: 0; transform: scale(.4) rotate(90deg); }
    .dbc-launcher.dbc-open .dbc-l-close { opacity: 1; transform: scale(1) rotate(0deg); }

    /* Unread badge */
    .dbc-badge {
      position: absolute; top: 1px; right: 1px;
      min-width: 18px; height: 18px; padding: 0 4px;
      border-radius: 9px;
      background: #f87171; border: 2px solid #080a0d;
      font-size: 10px; font-weight: 700; color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-family: 'DM Sans', sans-serif;
      animation: dbc-popin .22s cubic-bezier(.34,1.56,.64,1);
      pointer-events: none;
    }
    @keyframes dbc-popin { from { transform: scale(0); } to { transform: scale(1); } }

    /* ── Floating panel ───────────────────────────────────────── */
    .dbc-panel {
      position: fixed;
      z-index: 99997;
      width: 380px;
      max-width: calc(100vw - 32px);
      height: 560px;
      max-height: calc(100vh - 110px);
      display: flex; flex-direction: column;
      background: #0e0f11;
      border-radius: 18px;
      border: 1px solid #2a2d35;
      box-shadow: 0 32px 80px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.04);
      overflow: hidden;
      transition: opacity .22s ease, transform .28s cubic-bezier(.34,1.2,.64,1);
    }
    .dbc-panel[data-closed] {
      opacity: 0;
      pointer-events: none;
    }
    /* Per-position transform origins */
    .dbc-panel.dbc-p-br { transform-origin: bottom right; }
    .dbc-panel.dbc-p-bl { transform-origin: bottom left;  }
    .dbc-panel.dbc-p-bc { transform-origin: bottom center; }
    .dbc-panel[data-closed].dbc-p-br,
    .dbc-panel[data-closed].dbc-p-bl { transform: scale(.88) translateY(14px); }
    .dbc-panel[data-closed].dbc-p-bc  { transform: translateX(-50%) scale(.88) translateY(14px); }
    .dbc-panel.dbc-p-bc               { transform: translateX(-50%); }

    /* ── Panel header ─────────────────────────────────────────── */
    .dbc-header {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px;
      background: #16181c;
      border-bottom: 1px solid #2a2d35;
      flex-shrink: 0;
    }
    .dbc-header-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--dbc-accent, #4f8ef7);
      box-shadow: 0 0 8px var(--dbc-accent, #4f8ef7);
      animation: dbc-pulse 2.4s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes dbc-pulse {
      0%,100% { opacity:1; transform:scale(1); }
      50%      { opacity:.5; transform:scale(.8); }
    }
    .dbc-header-title {
      flex: 1; font-size: 14px; font-weight: 600;
      color: #e8ecf4; letter-spacing: .01em;
      font-family: 'DM Sans', sans-serif;
    }
    .dbc-header-clear {
      background: none; border: 1px solid #2a2d35; border-radius: 6px;
      color: #6b7280; font-family: 'DM Mono', monospace;
      font-size: 11px; padding: 4px 10px; cursor: pointer; transition: all .15s;
    }
    .dbc-header-clear:hover { border-color: var(--dbc-accent,#4f8ef7); color: #7eb8ff; }

    /* ── Messages ─────────────────────────────────────────────── */
    .dbc-messages {
      flex: 1; overflow-y: auto; padding: 16px 14px;
      display: flex; flex-direction: column; gap: 12px;
      scroll-behavior: smooth;
    }
    .dbc-messages::-webkit-scrollbar { width: 3px; }
    .dbc-messages::-webkit-scrollbar-thumb { background: #2a2d35; border-radius: 2px; }

    .dbc-empty {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 16px; text-align: center; padding: 20px;
    }
    .dbc-empty-icon {
      width: 48px; height: 48px; border-radius: 14px;
      background: #1e2128; border: 1px solid #2a2d35;
      display: flex; align-items: center; justify-content: center; font-size: 22px;
    }
    .dbc-empty-hl  { font-size: 14px; font-weight: 500; color: #c4c9d4; font-family:'DM Sans',sans-serif; }
    .dbc-empty-sub { font-size: 12px; color: #6b7280; line-height: 1.6; max-width: 260px; font-family:'DM Sans',sans-serif; margin-top: 4px; }
    .dbc-suggestions { display:flex; flex-wrap:wrap; gap:6px; justify-content:center; max-width:320px; }
    .dbc-chip {
      background:#1e2128; border:1px solid #2a2d35; border-radius:16px;
      color:#d4d8e2; font-size:11px; padding:5px 12px; cursor:pointer;
      transition:all .15s; font-family:'DM Sans',sans-serif; line-height:1.4; text-align:left;
    }
    .dbc-chip:hover { border-color:var(--dbc-accent,#4f8ef7); color:#7eb8ff; background:rgba(79,142,247,.08); }

    .dbc-msg { display:flex; flex-direction:column; gap:3px; animation:dbc-fi .18s ease-out; }
    @keyframes dbc-fi { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
    .dbc-msg--user { align-items:flex-end; }
    .dbc-msg--bot  { align-items:flex-start; }
    .dbc-bubble {
      max-width:86%; padding:9px 13px; border-radius:14px;
      line-height:1.65; font-size:13px; white-space:pre-wrap; word-break:break-word;
      font-family:'DM Sans',sans-serif;
    }
    .dbc-bubble--user { background:#1a2640; color:#c8dcff; border-bottom-right-radius:4px; border:1px solid rgba(79,142,247,.2); }
    .dbc-bubble--bot  { background:#1a1c22; color:#d4d8e2; border-bottom-left-radius:4px;  border:1px solid #2a2d35; }
    .dbc-bubble--err  { background:rgba(248,113,113,.08); color:#f87171; border:1px solid rgba(248,113,113,.25); border-bottom-left-radius:4px; }
    .dbc-time { font-size:10px; color:#6b7280; font-family:'DM Mono',monospace; padding:0 3px; }

    .dbc-typing {
      display:flex; align-items:center; gap:4px;
      padding:10px 13px; background:#1a1c22;
      border:1px solid #2a2d35; border-radius:14px; border-bottom-left-radius:4px; width:fit-content;
    }
    .dbc-typing span {
      width:5px; height:5px; border-radius:50%; background:#6b7280;
      animation:dbc-bn .9s ease-in-out infinite;
    }
    .dbc-typing span:nth-child(2){animation-delay:.15s}
    .dbc-typing span:nth-child(3){animation-delay:.3s}
    @keyframes dbc-bn{0%,100%{transform:translateY(0);opacity:.4}50%{transform:translateY(-4px);opacity:1}}

    /* Table */
    .dbc-tw  { overflow-x:auto; margin-top:6px; }
    .dbc-tbl { width:100%; border-collapse:collapse; font-size:11px; font-family:'DM Mono',monospace; }
    .dbc-tbl th { background:rgba(79,142,247,.12); color:#7eb8ff; padding:5px 8px; text-align:left; border-bottom:1px solid #2a2d35; font-weight:500; white-space:nowrap; }
    .dbc-tbl td { padding:4px 8px; border-bottom:1px solid rgba(42,45,53,.7); color:#d4d8e2; white-space:nowrap; }
    .dbc-tbl tr:last-child td{border-bottom:none}
    .dbc-tbl tr:hover td{background:rgba(255,255,255,.03)}

    /* Footer */
    .dbc-footer {
      padding:10px 12px; background:#16181c;
      border-top:1px solid #2a2d35;
      display:flex; gap:8px; align-items:flex-end; flex-shrink:0;
    }
    .dbc-ta {
      flex:1; background:#1e2128; border:1px solid #2a2d35; border-radius:10px;
      color:#e8ecf4; font-family:'DM Sans',sans-serif; font-size:13px;
      line-height:1.5; padding:9px 12px; resize:none;
      min-height:38px; max-height:120px; overflow-y:auto;
      transition:border-color .15s; outline:none;
    }
    .dbc-ta::placeholder{color:#6b7280}
    .dbc-ta:focus{border-color:var(--dbc-accent,#4f8ef7)}
    .dbc-send {
      width:36px; height:36px; border-radius:9px;
      background:var(--dbc-accent,#4f8ef7); border:none; cursor:pointer;
      display:flex; align-items:center; justify-content:center;
      flex-shrink:0; transition:all .15s; color:#fff;
    }
    .dbc-send:hover:not(:disabled){filter:brightness(1.15);transform:scale(1.06)}
    .dbc-send:disabled{opacity:.35;cursor:default;transform:none}
    .dbc-send svg{width:16px;height:16px}
  `;

  /* ─────────────────────────────────────────────────────────────────────────
     Helpers
  ───────────────────────────────────────────────────────────────────────── */
  function ts()  { return new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}); }
  function uid() { return Math.random().toString(36).slice(2,9); }

  function renderContent(text) {
    const lines = text.split("\n");
    const ti = lines.findIndex((l) => l.trim().startsWith("|") && l.includes("|"));
    if (ti === -1) return text;
    const tlines = [];
    let i = ti;
    while (i < lines.length && lines[i].trim().startsWith("|")) tlines.push(lines[i++]);
    const before  = lines.slice(0, ti).join("\n").trim();
    const after   = lines.slice(i).join("\n").trim();
    const headers = tlines[0].split("|").slice(1,-1).map(c=>c.trim());
    const rows    = tlines.slice(2).map(r=>r.split("|").slice(1,-1).map(c=>c.trim()));
    return h(React.Fragment, null,
      before && h("p",{style:{marginBottom:8}},before),
      h("div",{className:"dbc-tw"},
        h("table",{className:"dbc-tbl"},
          h("thead",null,h("tr",null,headers.map(hd=>h("th",{key:hd},hd)))),
          h("tbody",null,rows.map((row,ri)=>h("tr",{key:ri},row.map((c,ci)=>h("td",{key:ci},c)))))
        )
      ),
      after && h("p",{style:{marginTop:8}},after)
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
     Chat panel
  ───────────────────────────────────────────────────────────────────────── */
  function ChatPanel({ backendUrl, title, placeholder, suggestions, onNewMessage }) {
    const [msgs,    setMsgs]    = useState([]);
    const [input,   setInput]   = useState("");
    const [loading, setLoading] = useState(false);
    const bottomRef   = useRef(null);
    const textareaRef = useRef(null);

    useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [msgs, loading]);

    async function send(text) {
      const q = (text || input).trim();
      if (!q || loading) return;

      setMsgs(p => [...p, {id:uid(), role:"user", content:q, time:ts()}]);
      setInput(""); setLoading(true);
      if (textareaRef.current) textareaRef.current.style.height = "38px";

      // Add a placeholder bot message we'll update token-by-token
      const botId = uid();
      setMsgs(p => [...p, {id:botId, role:"assistant", content:"", time:ts(), streaming:true}]);

      try {
        const history = msgs.map(m => ({role:m.role, content:m.content}));
        const res = await fetch(`${backendUrl}/chat`, {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify({message:q, history}),
        });

        if (!res.ok) throw new Error(`Server error ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";

        while (true) {
          const {done, value} = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, {stream: true});
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete last line

          let event = null;
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              event = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const data = JSON.parse(line.slice(6));
              if (event === "token") {
                accumulated += data;
                setMsgs(p => p.map(m =>
                  m.id === botId ? {...m, content: accumulated} : m
                ));
              } else if (event === "status") {
                // Show a transient status line (replaces previous status)
                setMsgs(p => p.map(m =>
                  m.id === botId ? {...m, status: data} : m
                ));
              } else if (event === "error") {
                accumulated = "⚠ " + data;
                setMsgs(p => p.map(m =>
                  m.id === botId ? {...m, content: accumulated, error: true} : m
                ));
              } else if (event === "done") {
                // Clear status, mark streaming complete
                setMsgs(p => p.map(m =>
                  m.id === botId ? {...m, streaming: false, status: null} : m
                ));
                onNewMessage?.();
              }
              event = null;
            }
          }
        }
      } catch(err) {
        setMsgs(p => p.map(m =>
          m.id === botId ? {
            ...m,
            content: err instanceof TypeError
              ? `⚠ Could not reach backend at ${backendUrl}.`
              : `⚠ ${err.message}`,
            error: true,
            streaming: false,
            status: null,
          } : m
        ));
        onNewMessage?.();
      } finally {
        setLoading(false);
      }
    }

    function onInput(ev) {
      setInput(ev.target.value);
      const el=ev.target; el.style.height="38px";
      el.style.height=Math.min(el.scrollHeight,120)+"px";
    }

    const empty = msgs.length===0 && !loading;

    return h(React.Fragment, null,
      h("div",{className:"dbc-header"},
        h("div",{className:"dbc-header-dot"}),
        h("span",{className:"dbc-header-title"},title||"DB Assistant"),
        msgs.length>0 && h("button",{className:"dbc-header-clear",onClick:()=>setMsgs([])},"clear")
      ),
      h("div",{className:"dbc-messages"},
        empty
          ? h("div",{className:"dbc-empty"},
              h("div",{className:"dbc-empty-icon"},"🗄️"),
              h("div",null,
                h("p",{className:"dbc-empty-hl"},"What would you like to know?"),
                h("p",{className:"dbc-empty-sub"},"Ask anything in plain English — I'll query the database and explain the results.")
              ),
              suggestions?.length && h("div",{className:"dbc-suggestions"},
                suggestions.map(s=>h("button",{key:s,className:"dbc-chip",onClick:()=>send(s)},s))
              )
            )
          : msgs.map(msg=>{
              const isUser = msg.role==="user";
              // Bot bubble is "pending" when streaming but no tokens yet
              const isPending = !isUser && msg.streaming && !msg.content;
              const content = isUser ? msg.content : renderContent(msg.content);
              return h("div",{key:msg.id,className:`dbc-msg dbc-msg--${isUser?"user":"bot"}`},
                // Status pill (shown while DB query is running)
                !isUser && msg.status && h("div",{className:"dbc-status"},
                  h("div",{className:"dbc-status-dot"}),
                  msg.status
                ),
                h("div",{className:`dbc-bubble dbc-bubble--${isUser?"user":msg.error?"err":"bot"}`},
                  // Show typing dots when waiting for first token
                  isPending
                    ? h("div",{className:"dbc-typing"},h("span"),h("span"),h("span"))
                    : content,
                  // Blinking cursor once tokens are flowing
                  !isUser && msg.streaming && msg.content && h("span",{className:"dbc-cursor"})
                ),
                h("span",{className:"dbc-time"},msg.time)
              );
            }),
        h("div",{ref:bottomRef})
      ),
      h("div",{className:"dbc-footer"},
        h("textarea",{
          ref:textareaRef, className:"dbc-ta",
          placeholder:placeholder||"Ask about your data…",
          value:input, onChange:onInput, rows:1, disabled:loading,
          onKeyDown:ev=>{ if(ev.key==="Enter"&&!ev.shiftKey){ev.preventDefault();send();} }
        }),
        h("button",{
          className:"dbc-send", onClick:()=>send(),
          disabled:!input.trim()||loading, title:"Send (Enter)",
        },
          h("svg",{viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"},
            h("line",{x1:22,y1:2,x2:11,y2:13}),
            h("polygon",{points:"22 2 15 22 11 13 2 9 22 2"})
          )
        )
      )
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
     Root — balloon + panel
  ───────────────────────────────────────────────────────────────────────── */
  function FloatingWidget({ backendUrl, title, placeholder, suggestions, position, offset, balloonIcon, accentColor }) {
    const [open,   setOpen]   = useState(false);
    const [unread, setUnread] = useState(0);

    const pos = position || "bottom-right";
    const off = { x:24, y:24, ...(offset||{}) };
    const isLeft   = pos==="bottom-left";
    const isCenter = pos==="bottom-center";
    const accent   = accentColor || "#4f8ef7";

    // Launcher position
    const launcherPos = {
      bottom: off.y,
      "--dbc-accent": accent,
      ...(isCenter ? {left:"50%",marginLeft:"-29px"} : isLeft ? {left:off.x} : {right:off.x}),
    };

    // Panel position
    const panelBottom = off.y + 58 + 12;
    const panelPos = {
      bottom: panelBottom,
      "--dbc-accent": accent,
      ...(isCenter ? {left:"50%"} : isLeft ? {left:off.x} : {right:off.x}),
    };
    const panelClass = `dbc-panel dbc-p-${isCenter?"bc":isLeft?"bl":"br"}`;

    function toggle() {
      const next = !open;
      setOpen(next);
      if (next) setUnread(0);
    }

    return h("div",{className:"dbc-wrap"},
      /* Panel */
      h("div",{
        className: panelClass,
        style: panelPos,
        ...(!open ? {"data-closed":""} : {}),
      }, h(ChatPanel,{backendUrl,title,placeholder,suggestions,onNewMessage:()=>{ if(!open) setUnread(n=>n+1); }})),

      /* Balloon */
      h("button",{
        className:`dbc-launcher${open?" dbc-open":""}`,
        style: launcherPos,
        onClick: toggle,
        "aria-label": open?"Close chat":"Open chat",
      },
        h("div",{className:"dbc-launcher-inner"},
          h("span",{className:"dbc-l-icon"}, balloonIcon||"🗄️"),
          h("span",{className:"dbc-l-close"},"✕"),
          (!open && unread>0) && h("span",{className:"dbc-badge"}, unread>9?"9+":unread)
        )
      )
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
     Public API
  ───────────────────────────────────────────────────────────────────────── */
  function init(options={}) {
    const {
      backendUrl  = "http://localhost:8000",
      title, placeholder, suggestions,
      position    = "bottom-right",
      offset, balloonIcon, accentColor,
    } = options;

    if (!document.getElementById("dbc-styles")) {
      const s=document.createElement("style");
      s.id="dbc-styles"; s.textContent=STYLES;
      document.head.appendChild(s);
    }

    let host=document.getElementById("dbc-host");
    if (!host) {
      host=document.createElement("div");
      host.id="dbc-host";
      document.body.appendChild(host);
    }

    ReactDOM.createRoot(host).render(
      h(FloatingWidget,{backendUrl,title,placeholder,suggestions,position,offset,balloonIcon,accentColor})
    );
  }

  global.DBChatWidget = { init };
})(window);
