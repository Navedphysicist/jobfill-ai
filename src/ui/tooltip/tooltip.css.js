// src/ui/tooltip/tooltip.css.js
export const TOOLTIP_CSS = `
:host { all: initial; }
.box {
  position: fixed; width: 360px; max-width: calc(100vw - 16px);
  font: 13px/1.45 system-ui, sans-serif; color: #1a1a1a; background: #fff;
  border: 1px solid #d8d8d8; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18); z-index: 2147483647;
  display: flex; flex-direction: column; overflow: hidden;
}
@media (prefers-color-scheme: dark) {
  .box { color: #e8e8e8; background: #1d1f24; border-color: #343841; }
  select, textarea, input, button.ghost { color: #e8e8e8; background: #14161a; border-color: #343841; }
}
.row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
.row.head { border-bottom: 1px solid #ececec; }
.row.foot { border-top: 1px solid #ececec; justify-content: flex-end; }
.badge { margin-left: auto; font-size: 11px; color: #2f855a; }
textarea[data-part="text"] { border: 0; outline: none; resize: vertical; min-height: 120px;
  padding: 10px; font: inherit; background: transparent; color: inherit; }
input[data-part="instruction"] { flex: 1; padding: 5px 7px; border: 1px solid #ddd;
  border-radius: 5px; font: inherit; background: transparent; color: inherit; }
button { font: inherit; border-radius: 6px; cursor: pointer; padding: 5px 9px; }
button.ghost { background: transparent; border: 1px solid #ddd; }
button.primary { background: #2b6cb0; color: #fff; border: 0; padding: 6px 14px; }
button:disabled { opacity: .5; cursor: default; }
select { font: inherit; border: 1px solid #ddd; border-radius: 5px; padding: 3px 5px;
  background: transparent; color: inherit; }
.error { color: #c53030; font-size: 12px; padding: 0 10px 8px; }
.error:empty { display: none; }
.loading textarea { opacity: .45; }
`;
