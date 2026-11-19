// Note Sidekick — side panel logic.
// Each note is stored in chrome.storage.local under "note:<id>":
//   { id, title, html, pinned, folderId, created, updated, deleted? }
// Deleted notes keep their record with a "deleted" timestamp and show up in
// Recently Deleted until they're recovered, deleted for good, or 30 days pass.
// Folders are stored under "folders" (see the folders section).
// Images live inside the note HTML as data: URLs ("unlimitedStorage" lifts the 10 MB cap).

const $ = (s) => document.querySelector(s);
const listView = $("#listView"), editorView = $("#editorView");
const noteList = $("#noteList"), search = $("#search"), editor = $("#editor");
const titleInput = $("#titleInput"), saveState = $("#saveState"), pinBtn = $("#pinBtn");

const MAX_IMG_DIM = 1800;          // downscale pasted images larger than this
const RECOMPRESS_OVER = 400 * 1024; // only re-encode images bigger than ~400 KB

let current = null;   // the note being edited
let saveTimer = null;

// ---------- storage ----------
const key = (id) => "note:" + id;
async function getAllNotes(includeDeleted = false) {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k, v]) => k.startsWith("note:") && (includeDeleted || !v.deleted)).map(([, v]) => v);
}
const getDeletedNotes = async () => (await getAllNotes(true)).filter((n) => n.deleted);
const putNote = (n) => chrome.storage.local.set({ [key(n.id)]: n });
const removeNote = (id) => chrome.storage.local.remove(key(id)); // permanent

// ---------- recently deleted ----------
const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const isBlank = (n) => !n.title && !plainText(n.html || "") && !/<img/i.test(n.html || "");
// Blank notes are just removed; anything else goes to Recently Deleted.
async function trashNote(n) {
  if (isBlank(n)) { await removeNote(n.id); return; }
  await putNote({ ...n, deleted: Date.now() });
}
async function recoverNote(n) {
  const { deleted, ...rest } = n;
  await putNote({ ...rest, updated: Date.now() });
}
const daysLeft = (n) => Math.max(0, Math.ceil((n.deleted + TRASH_DAYS * DAY - Date.now()) / DAY));
async function purgeOldDeleted() {
  const old = (await getDeletedNotes()).filter((n) => Date.now() - n.deleted > TRASH_DAYS * DAY);
  if (old.length) await chrome.storage.local.remove(old.map((n) => key(n.id)));
}
async function emptyTrash() {
  const gone = await getDeletedNotes();
  if (!gone.length) return;
  if (!confirm(`Permanently delete ${gone.length} note${gone.length > 1 ? "s" : ""}? This can't be undone.`)) return;
  await chrome.storage.local.remove(gone.map((n) => key(n.id)));
  renderList();
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- list view ----------
function plainText(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  d.querySelectorAll("li, p, div, br").forEach((el) => { el.before(" "); el.append(" "); });
  return d.textContent.replace(/\s+/g, " ").trim();
}
function firstImage(html) {
  const m = html.match(/<img[^>]+src="([^"]+)"/);
  return m ? m[1] : null;
}
function fmtDate(t) {
  const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

// ---------- folders ----------
// Folders live under "folders": [{ id, name }]. A note's folderId points at one (or is null).
// "Favorites" is built in: it shows every starred (pinned) note, whatever folder it's in.
// List screens: "all" (every note) → "folders" (the folder list) → a folder id (that folder's notes).
// "fav" and "trash" (Recently Deleted) are reached from their header buttons.
let folders = [];
let view = "all";
try { view = localStorage.getItem("view") || "all"; } catch {}
const loadFolders = async () => (folders = (await chrome.storage.local.get("folders")).folders || []);
const saveFolders = () => chrome.storage.local.set({ folders });
const folderById = (id) => folders.find((f) => f.id === id);
const sortedFolders = () => [...folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
const inFolderView = () => view === "fav" || !!folderById(view);

function setView(v) {
  view = v;
  try { localStorage.setItem("view", v); } catch {}
  search.value = "";
  renderList();
}
const goUp = () => setView(folderById(view) ? "folders" : "all");
async function addFolder(name) {
  const existing = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const f = { id: newId(), name };
  folders.push(f);
  await saveFolders();
  return f;
}
// Swap an element for a text box; calls onDone(name) on Enter/blur, re-renders on Escape.
function askName(anchor, initial, onDone) {
  const input = document.createElement("input");
  input.className = "name-input";
  input.placeholder = "Folder name";
  input.value = initial;
  anchor.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.replaceWith(anchor);
    if (ok && v) onDone(v); else renderList();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") { e.stopPropagation(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation()); // don't open the row it sits in
  return input;
}
// One row in the list: icon, name, count, chevron.
function navRow(icon, label, count, onClick, extraClass = "") {
  const li = document.createElement("li");
  li.className = "nav-row " + extraClass;
  const i = document.createElement("span"); i.className = "icon"; i.textContent = icon;
  const name = document.createElement("span"); name.className = "name"; name.textContent = label;
  li.append(i, name);
  if (count !== null) { const n = document.createElement("span"); n.className = "n"; n.textContent = count; li.append(n); }
  const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "›";
  li.append(chev);
  li.onclick = onClick;
  return li;
}
function renderFolders(all, q) {
  const count = (fn) => all.filter(fn).length;
  const rows = sortedFolders().filter((f) => !q || f.name.toLowerCase().includes(q));
  for (const f of rows) {
    const li = navRow("📁", f.name, count((n) => n.folderId === f.id), () => setView(f.id));
    li.append(folderActions(f, li.querySelector(".name")));
    noteList.append(li);
  }
  const add = document.createElement("li");
  add.className = "nav-row add-row";
  add.textContent = "+ New folder";
  add.onclick = () => askName(add, "", async (name) => { await addFolder(name); renderList(); });
  noteList.append(add);
  $("#empty").classList.toggle("hidden", rows.length > 0);
  $("#empty").textContent = q ? "No folders match your search." : "No folders yet.";
}
$("#listBackBtn").onclick = goUp;
// Header shortcuts: click again to go back to all notes.
$("#foldersBtn").onclick = () => setView(view === "folders" ? "all" : "folders");
$("#favBtn").onclick = () => setView(view === "fav" ? "all" : "fav");
$("#trashBtn").onclick = () => setView(view === "trash" ? "all" : "trash");
$("#renameFolderBtn").onclick = () => {
  const f = folderById(view);
  if (!f) return;
  askName($("#listTitle"), f.name, async (name) => { f.name = name; await saveFolders(); renderList(); });
};
$("#deleteFolderBtn").onclick = async () => {
  const f = folderById(view);
  if (f && await deleteFolder(f)) setView("folders");
};
// Asks first; moves the folder's notes back to All notes. Returns true if deleted.
async function deleteFolder(f) {
  const inside = (await getAllNotes()).filter((n) => n.folderId === f.id);
  const msg = inside.length
    ? `Delete the folder "${f.name}"?\n\nIts ${inside.length} note${inside.length > 1 ? "s" : ""} won't be deleted — they'll stay in All notes.`
    : `Delete the empty folder "${f.name}"?`;
  if (!confirm(msg)) return false;
  const batch = {};
  for (const n of inside) batch[key(n.id)] = { ...n, folderId: null };
  folders = folders.filter((x) => x.id !== f.id);
  await chrome.storage.local.set({ ...batch, folders });
  return true;
}
// Folder button in the note header: highlighted when the note is in a folder; opens a menu.
const folderBtn = $("#folderBtn"), folderMenu = $("#folderMenu");
function updateFolderBtn(n) {
  const f = folderById(n.folderId);
  folderBtn.classList.toggle("active", !!f);
  folderBtn.title = f ? `In folder: ${f.name}` : "Move to folder";
  closeFolderMenu();
}
function closeFolderMenu() {
  folderMenu.classList.add("hidden");
  folderBtn.setAttribute("aria-expanded", "false");
}
async function moveCurrentTo(id) {
  closeFolderMenu();
  if (!current) return;
  current.folderId = id;
  await putNote(current);
  updateFolderBtn(current);
}
function buildFolderMenu() {
  folderMenu.innerHTML = "";
  const item = (label, cls, onPick) => {
    const b = document.createElement("button");
    b.className = "fm-item " + cls; b.setAttribute("role", "menuitem"); b.textContent = label;
    b.onclick = onPick;
    folderMenu.append(b);
    return b;
  };
  const cur = folderById(current?.folderId) ? current.folderId : null;
  const list = sortedFolders();
  if (list.length) {
    for (const f of list) item("📁 " + f.name, f.id === cur ? "current" : "", () => moveCurrentTo(f.id));
    if (cur) item("Remove from folder", "muted-item", () => moveCurrentTo(null));
    folderMenu.append(Object.assign(document.createElement("div"), { className: "fm-sep" }));
  } else {
    folderMenu.append(Object.assign(document.createElement("div"), { className: "fm-empty", textContent: "No folders yet" }));
  }
  const add = item("+ New folder", "add-item", () => {
    const input = document.createElement("input");
    input.className = "name-input fm-input"; input.placeholder = "Folder name";
    add.replaceWith(input);
    input.focus();
    let done = false;
    const finish = async (ok) => {
      if (done) return; done = true;
      const name = input.value.trim();
      if (ok && name) await moveCurrentTo((await addFolder(name)).id);
      else closeFolderMenu();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") { e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  });
}
folderBtn.onclick = async () => {
  if (!folderMenu.classList.contains("hidden")) { closeFolderMenu(); return; }
  await loadFolders();
  buildFolderMenu();
  folderMenu.classList.remove("hidden");
  folderBtn.setAttribute("aria-expanded", "true");
};
document.addEventListener("mousedown", (e) => { if (!e.target.closest(".folder-wrap")) closeFolderMenu(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || folderMenu.classList.contains("hidden")) return;
  e.stopImmediatePropagation(); // Escape closes the menu instead of leaving the note
  closeFolderMenu();
}, true);

// Hover buttons on a note row: rename (inline) and delete.
const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/></svg>';
function hoverActions(onRename, onDelete, what = "") {
  const wrap = document.createElement("div");
  wrap.className = "row-actions";
  const btn = (cls, title, svg, fn) => {
    const b = document.createElement("button");
    b.className = "row-btn " + cls; b.title = title; b.setAttribute("aria-label", title); b.innerHTML = svg;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    wrap.append(b);
  };
  btn("", "Rename" + what, ICON_EDIT, onRename);
  btn("danger", "Delete" + what, ICON_TRASH, onDelete);
  return wrap;
}
function rowActions(n, titleEl) {
  return hoverActions(() => {
    const input = askName(titleEl, n.title || "", async (title) => {
      n.title = title;
      await putNote(n);
      renderList();
    });
    input.placeholder = "Note title";
  }, async () => {
    await trashNote(n);
    renderList();
  });
}
// Buttons on a Recently Deleted row: recover, or delete for good.
const ICON_RESTORE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8H12z"/></svg>';
function trashActions(n) {
  const wrap = document.createElement("div");
  wrap.className = "row-actions trash-actions";
  const btn = (cls, label, svg, fn) => {
    const b = document.createElement("button");
    b.className = "row-btn " + cls; b.title = label; b.setAttribute("aria-label", label); b.innerHTML = svg;
    b.onclick = async (e) => { e.stopPropagation(); await fn(); renderList(); };
    wrap.append(b);
  };
  btn("", "Recover", ICON_RESTORE, () => recoverNote(n));
  btn("danger", "Delete permanently", ICON_TRASH, async () => {
    if (confirm(`Permanently delete "${n.title || "Untitled"}"? This can't be undone.`)) await removeNote(n.id);
  });
  return wrap;
}
function folderActions(f, nameEl) {
  return hoverActions(
    () => askName(nameEl, f.name, async (name) => { f.name = name; await saveFolders(); renderList(); }),
    async () => { if (await deleteFolder(f)) renderList(); },
    " folder"
  );
}

async function renderList() {
  const q = search.value.trim().toLowerCase();
  await loadFolders();
  if (view !== "all" && view !== "folders" && view !== "trash" && !inFolderView()) view = "all";
  const everything = await getAllNotes(true);
  const all = everything.filter((n) => !n.deleted);
  const trashed = everything.filter((n) => n.deleted);
  const folder = folderById(view);
  const trash = view === "trash";

  // header
  $("#listTitle").textContent = view === "folders" ? "Folders" : view === "fav" ? "★ Favorites" : trash ? "Recently Deleted" : folder ? "📁 " + folder.name : "Notes";
  $("#listBackBtn").classList.toggle("hidden", view === "all");
  $("#listBackBtn").title = folder ? "Folders" : "All notes";
  $("#renameFolderBtn").classList.toggle("hidden", !folder);
  $("#deleteFolderBtn").classList.toggle("hidden", !folder);
  $("#newBtn").classList.toggle("hidden", view === "folders" || trash);
  $("#emptyTrashBtn").classList.toggle("hidden", !trash || !trashed.length);
  $("#foldersBtn").classList.toggle("active", view === "folders" || !!folder);
  $("#trashBtn").classList.toggle("active", trash);
  $("#trashBtn").classList.toggle("hidden", !!folder); // folders have their own delete-folder 🗑
  $("#favBtn").classList.toggle("active", view === "fav");
  search.placeholder = view === "folders" ? "Search folders…" : "Search notes…";

  noteList.innerHTML = "";
  if (view === "folders") { $("#count").textContent = ""; renderFolders(all, q); return; }

  let notes = trash ? trashed : all.filter((n) => view === "all" || (view === "fav" ? n.pinned : n.folderId === view));
  $("#count").textContent = notes.length ? `(${notes.length})` : "";
  if (trash) notes.sort((a, b) => b.deleted - a.deleted);
  else notes.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
  if (q) notes = notes.filter((n) => (n.title + " " + plainText(n.html)).toLowerCase().includes(q));

  $("#empty").classList.toggle("hidden", notes.length > 0);
  if (q) $("#empty").textContent = "No notes match your search.";
  else if (trash) $("#empty").textContent = `No recently deleted notes. Deleted notes stay here for ${TRASH_DAYS} days.`;
  else if (view === "fav") $("#empty").textContent = "No favorites yet. Star a note (☆) to add it here.";
  else if (folder) $("#empty").innerHTML = "This folder is empty. Click <b>+ New</b> to add a note here, or move a note in with the folder menu at the top of the note.";
  else $("#empty").innerHTML = "No notes yet. Click <b>+ New</b> to start.";

  for (const n of notes) {
    const text = plainText(n.html);
    const li = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = (n.pinned ? "★ " : "") + (n.title || "Untitled");
    const p = document.createElement("div");
    p.className = "p";
    p.textContent = text;
    const imgCount = (n.html.match(/<img/g) || []).length;
    const d = document.createElement("div");
    d.className = "d";
    const nf = !folder && folderById(n.folderId);
    d.textContent = trash
      ? `Deleted ${fmtDate(n.deleted)} · ${daysLeft(n)} day${daysLeft(n) === 1 ? "" : "s"} left` + (imgCount ? ` · ${imgCount} image${imgCount > 1 ? "s" : ""}` : "")
      : fmtDate(n.updated) + (imgCount ? ` · ${imgCount} image${imgCount > 1 ? "s" : ""}` : "") + (nf ? ` · 📁 ${nf.name}` : "");
    meta.append(t, p, d);
    li.append(meta);
    const src = firstImage(n.html);
    if (src) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = src;
      li.append(img);
    }
    if (trash) { li.classList.add("trashed"); li.append(trashActions(n)); }
    else { li.onclick = () => openNote(n); li.append(rowActions(n, t)); }
    noteList.append(li);
  }
}

// ---------- editor ----------
function showList() {
  flushSave();
  current = null;
  editorView.classList.add("hidden");
  listView.classList.remove("hidden");
  renderList();
}
function openNote(n) {
  current = n;
  titleInput.value = n.title || "";
  editor.innerHTML = n.html || "";
  pinBtn.textContent = n.pinned ? "★" : "☆";
  pinBtn.title = n.pinned ? "Remove from Favorites" : "Add to Favorites";
  updateFolderBtn(n);
  saveState.textContent = "";
  listView.classList.add("hidden");
  editorView.classList.remove("hidden");
  editor.focus();
}
async function createNote(initialHtml = "") {
  const now = Date.now();
  // New notes land in the folder you're looking at (or Favorites)
  const n = { id: newId(), title: "", html: initialHtml, pinned: view === "fav", folderId: folderById(view) ? view : null, created: now, updated: now };
  await putNote(n);
  openNote(n);
  return n;
}

function scheduleSave() {
  if (!current) return;
  saveState.textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!current) return;
  const html = editor.innerHTML.replace(/ class="selected"/g, ""); // don't save the selection highlight
  const title = titleInput.value.trim();
  if (html === current.html && title === current.title) { saveState.textContent = "Saved"; return; }
  current.html = html;
  current.title = title;
  current.updated = Date.now();
  await putNote(current);
  saveState.textContent = "Saved";
}

// ---------- images ----------
function readAsDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
async function fileToDataURL(file) {
  // GIFs keep their animation; small images are stored as-is.
  if (file.type === "image/gif" || file.type === "image/svg+xml") return readAsDataURL(file);
  const bmp = await createImageBitmap(file);
  const tooBig = bmp.width > MAX_IMG_DIM || bmp.height > MAX_IMG_DIM;
  if (!tooBig && file.size < RECOMPRESS_OVER) { bmp.close(); return readAsDataURL(file); }
  const scale = Math.min(1, MAX_IMG_DIM / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL("image/webp", 0.88); // keeps transparency, much smaller than PNG
}

function insertNodeAtCursor(node) {
  editor.focus();
  const sel = window.getSelection();
  let range = sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!range || !editor.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.deleteContents();
  // A DocumentFragment empties itself on insert, so remember its last child.
  const last = node.nodeType === 11 ? node.lastChild : node;
  range.insertNode(node);
  range.setStartAfter(last);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
// Put the caret inside the editor (at the end if it's elsewhere).
function ensureCaretInEditor() {
  editor.focus();
  const sel = window.getSelection();
  if (sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
  const r = document.createRange();
  r.selectNodeContents(editor);
  r.collapse(false);
  sel.removeAllRanges(); sel.addRange(r);
}
// Insert HTML through execCommand so Ctrl+Z can undo it. The element marked
// data-caret (if any) gets the caret afterwards.
function insertUndoable(html) {
  ensureCaretInEditor();
  document.execCommand("insertHTML", false, html);
  const mark = editor.querySelector("[data-caret]");
  if (mark) {
    mark.removeAttribute("data-caret");
    const sel = window.getSelection(), r = document.createRange();
    r.setStart(mark, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
  }
  scheduleSave();
}
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
function insertImage(src) {
  // the empty line after gives you somewhere to keep typing under the image
  insertUndoable(`<img src="${escAttr(src)}"><div data-caret><br></div>`);
}
async function insertImageFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    try { insertImage(await fileToDataURL(f)); }
    catch (e) { console.error("Image insert failed", e); }
  }
}

// ---------- pasting ----------
const ALLOWED = new Set(["B","STRONG","I","EM","U","S","P","BR","DIV","UL","OL","LI","A","H1","H2","H3","H4","BLOCKQUOTE","PRE","CODE","IMG","SPAN","TABLE","THEAD","TBODY","TR","TD","TH","HR"]);
// keepColors: preserve our own text color / highlight styles (used for imports, not pastes).
function sanitize(html, keepColors = false) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (el) => {
    for (const child of [...el.children]) {
      if (!ALLOWED.has(child.tagName)) {
        if (["SCRIPT","STYLE","META","LINK","IFRAME","OBJECT","TITLE"].includes(child.tagName)) child.remove();
        else { walk(child); child.replaceWith(...child.childNodes); }
        continue;
      }
      for (const a of [...child.attributes]) {
        const keep = (child.tagName === "A" && a.name === "href" && /^https?:/i.test(a.value)) ||
                     (child.tagName === "IMG" && a.name === "src" && /^(https?:|data:image\/)/i.test(a.value));
        if (keepColors && child.tagName === "SPAN" && a.name === "style") {
          const { color, backgroundColor } = child.style;
          child.removeAttribute("style");
          if (/^(rgb\([\d, ]+\)|#[0-9a-f]{3,8}|var\(--text\)|transparent)$/i.test(color)) child.style.color = color;
          if (/^(rgb\([\d, ]+\)|#[0-9a-f]{3,8}|transparent)$/i.test(backgroundColor)) child.style.backgroundColor = backgroundColor;
          if (!child.getAttribute("style")) child.removeAttribute("style");
          continue;
        }
        if (!keep) child.removeAttribute(a.name);
      }
      if (child.tagName === "A") child.setAttribute("target", "_blank");
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

editor.addEventListener("paste", async (e) => {
  const cd = e.clipboardData;
  let files = [...cd.files].filter((f) => f.type.startsWith("image/"));
  if (!files.length) // some apps only expose images via items
    files = [...cd.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter(Boolean);
  const html = cd.getData("text/html");
  // Several images copied from a note arrive as HTML: keep them as separate images.
  const embedded = html && /<img[^>]+src="data:image\//i.test(html);
  if (files.length && !embedded) {  // screenshot / copied image
    e.preventDefault();
    await insertImageFiles(files);
    return;
  }
  e.preventDefault();
  if (html) document.execCommand("insertHTML", false, sanitize(html));
  else document.execCommand("insertText", false, cd.getData("text/plain"));
  scheduleSave();
});

// Drag & drop images (from your desktop or from another tab)
editor.addEventListener("dragover", (e) => { e.preventDefault(); editor.classList.add("dragover"); });
editor.addEventListener("dragleave", () => editor.classList.remove("dragover"));
editor.addEventListener("drop", async (e) => {
  editor.classList.remove("dragover");
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    e.preventDefault();
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (pos) { const s = getSelection(); s.removeAllRanges(); s.addRange(pos); }
    await insertImageFiles(files);
    return;
  }
  const html = e.dataTransfer.getData("text/html");
  const m = html && html.match(/<img[^>]+src="([^"]+)"/);
  if (m) { e.preventDefault(); insertImage(m[1]); }
});

$("#imgBtn").onclick = () => $("#imgInput").click();
$("#imgInput").onchange = async (e) => { await insertImageFiles([...e.target.files]); e.target.value = ""; };

// ---------- image selection & copying ----------
// Click = select one image. Ctrl/Cmd/Shift+click = add/remove more.
// Dragging a text selection across images also counts.
// Ctrl/Cmd+C copies every selected image; Delete removes them; Esc clears.
const selectedImgs = () => [...editor.querySelectorAll("img.selected")];
function clearImgSelection() {
  selectedImgs().forEach((i) => i.classList.remove("selected"));
  updateSelBar();
}
function imagesInRange() {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return [];
  const r = s.getRangeAt(0);
  return [...editor.querySelectorAll("img")].filter((i) => r.intersectsNode(i));
}
// Images to act on: clicked selection first, otherwise an image-only drag selection.
function targetImages() {
  const picked = selectedImgs();
  if (picked.length) return picked;
  const inRange = imagesInRange();
  return inRange.length && !getSelection().toString().trim() ? inRange : [];
}
function updateSelBar() {
  const n = selectedImgs().length;
  $("#selBar").classList.toggle("hidden", n === 0);
  $("#selCount").textContent = `${n} image${n === 1 ? "" : "s"} selected`;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 2200);
}

async function loaded(img) {
  if (!img.complete || !img.naturalWidth) await img.decode().catch(() => {});
  return img;
}
function canvasToBlob(c) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}
// One PNG for one image; several are stacked into a single PNG for apps that only take one image.
async function imagesToPng(imgs) {
  imgs = await Promise.all(imgs.map(loaded));
  const gap = imgs.length > 1 ? 16 : 0;
  let w = Math.max(...imgs.map((i) => i.naturalWidth));
  let h = imgs.reduce((s, i) => s + i.naturalHeight, 0) + gap * (imgs.length - 1);
  const scale = Math.min(1, 16000 / h, 8000 / w); // stay inside browser canvas limits
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext("2d");
  if (imgs.length > 1) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
  let y = 0;
  for (const i of imgs) {
    const iw = i.naturalWidth * scale, ih = i.naturalHeight * scale;
    ctx.drawImage(i, 0, y, iw, ih);
    y += ih + gap * scale;
  }
  return canvasToBlob(c);
}
// Separate images as HTML, so Docs, Gmail, Notion, Word and Note Sidekick get each one individually.
async function imagesToHtml(imgs) {
  const parts = [];
  for (const i of imgs) {
    let src = i.src;
    try { // PNG data URLs paste more reliably than WebP in other apps
      const c = document.createElement("canvas");
      await loaded(i);
      c.width = i.naturalWidth; c.height = i.naturalHeight;
      c.getContext("2d").drawImage(i, 0, 0);
      src = c.toDataURL("image/png");
    } catch {}
    parts.push(`<img src="${src}">`);
  }
  return new Blob([parts.join("<br>")], { type: "text/html" });
}
async function copyImages(imgs) {
  if (!imgs.length) return;
  const label = `${imgs.length} image${imgs.length > 1 ? "s" : ""}`;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": imagesToPng(imgs), "text/html": imagesToHtml(imgs) }),
    ]);
    toast(`Copied ${label}`);
  } catch (err) {
    // An image linked from another site can't be turned into a PNG; copy it as HTML instead.
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": imagesToHtml(imgs) })]);
      toast(`Copied ${label}`);
    } catch (err2) {
      console.error(err, err2);
      toast("Couldn't copy: " + err2.message);
    }
  }
}
function deleteImages(imgs) {
  // Delete through execCommand so Ctrl+Z brings the images back.
  editor.focus();
  const sel = window.getSelection();
  for (const img of imgs) {
    img.classList.remove("selected");
    if (!img.getAttribute("class")) img.removeAttribute("class");
    const r = document.createRange();
    r.selectNode(img);
    sel.removeAllRanges(); sel.addRange(r);
    document.execCommand("delete");
  }
  updateSelBar();
  scheduleSave();
}
function downloadImages(imgs) {
  imgs.forEach((img, n) => {
    const a = document.createElement("a");
    a.href = img.src;
    const ext = (img.src.match(/^data:image\/(\w+)/) || [, "png"])[1];
    a.download = `${(titleInput.value || "note").replace(/[^\w-]+/g, "_")}-${n + 1}.${ext}`;
    a.click();
  });
}

$("#selCopy").onclick = () => copyImages(selectedImgs());
$("#selDownload").onclick = () => downloadImages(selectedImgs());
$("#selDelete").onclick = () => deleteImages(selectedImgs());
$("#selAll").onclick = () => { editor.querySelectorAll("img").forEach((i) => i.classList.add("selected")); updateSelBar(); };
$("#selClear").onclick = clearImgSelection;

// Keep a multi-image click from turning into a text selection.
editor.addEventListener("mousedown", (e) => {
  if (e.target.tagName === "IMG" && (e.shiftKey || e.ctrlKey || e.metaKey)) e.preventDefault();
});
editor.addEventListener("click", (e) => {
  if (e.target.tagName === "IMG") {
    if (e.shiftKey || e.ctrlKey || e.metaKey) e.target.classList.toggle("selected");
    else { clearImgSelection(); e.target.classList.add("selected"); }
  } else if (!e.shiftKey) {
    clearImgSelection();
  }
  updateSelBar();
  // checklist toggle when clicking the box area
  const li = e.target.closest("ul.checklist > li");
  if (li && e.clientX - li.getBoundingClientRect().left < 28) {
    li.classList.toggle("done");
    scheduleSave();
  }
});
editor.addEventListener("dblclick", (e) => {
  if (e.target.tagName !== "IMG") return;
  $("#lightbox img").src = e.target.src;
  $("#lightbox").classList.remove("hidden");
});
$("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); // keep focus in the note
    indent(e.shiftKey);
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const picked = selectedImgs();
  if (mod && (e.key === "c" || e.key === "x")) {
    const imgs = targetImages();
    if (!imgs.length) return; // normal text copy
    e.preventDefault();
    copyImages(imgs).then(() => { if (e.key === "x") deleteImages(imgs); });
  } else if (picked.length && (e.key === "Delete" || e.key === "Backspace")) {
    e.preventDefault();
    deleteImages(picked);
  } else if (mod && e.key === "a" && picked.length) { // Ctrl+A while images are selected = all images
    e.preventDefault();
    editor.querySelectorAll("img").forEach((i) => i.classList.add("selected"));
    updateSelBar();
  } else if (picked.length && !e.shiftKey && !mod && e.key.length === 1) {
    clearImgSelection(); // typing goes back to normal editing
  }
});

// ---------- toolbar ----------
document.querySelectorAll(".toolbar [data-cmd]").forEach((b) =>
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();               // keep the text selection
    document.execCommand(b.dataset.cmd);
    scheduleSave();
    updateToolbarState();
  })
);

// Highlight toolbar buttons whose formatting is active at the caret/selection
function updateToolbarState() {
  const sel = getSelection();
  const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
  const inEditor = !!node && editor.contains(node);
  const inChecklist = inEditor && !!node.closest("ul.checklist");
  document.querySelectorAll(".toolbar [data-cmd]").forEach((b) => {
    let on = false;
    if (inEditor) {
      try { on = document.queryCommandState(b.dataset.cmd); } catch {}
      if (b.dataset.cmd === "insertUnorderedList" && inChecklist) on = false;
    }
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);
  });
  $("#checkBtn").classList.toggle("active", inChecklist);
  updateColorBars(inEditor ? node : null);
}

// ---------- text color & highlight ----------
const TEXT_COLORS = ["#d93025", "#e8710a", "#b8860b", "#188038", "#1a73e8", "#9334e6",
                     "#d01884", "#795548", "#5f6368", "#0b8043", "#12b5cb", "#3f51b5"];
const HILITE_COLORS = ["#fff475", "#fbbc04", "#ccff90", "#a7ffeb", "#aecbfa", "#d7aefb",
                       "#fdcfe8", "#f28b82", "#ffd8a8", "#e6c9a8", "#e8eaed", "#cbf0f8"];
const SENTINEL = "rgb(1, 2, 3)"; // marks "remove color" until we clean it up
const COLOR_KINDS = {
  text:   { cmd: "foreColor",   prop: "color",           btn: $("#textColorBtn"), menu: $("#textColorMenu"), colors: TEXT_COLORS,   resetLabel: "Default color" },
  hilite: { cmd: "hiliteColor", prop: "backgroundColor", btn: $("#hiliteBtn"),    menu: $("#hiliteMenu"),    colors: HILITE_COLORS, resetLabel: "No highlight" },
};

// Nearest inline color/highlight set inside the editor for a node, or "".
function inlineColorAt(node, prop) {
  for (let el = node; el && el !== editor; el = el.parentElement) if (el.style?.[prop]) return el.style[prop];
  return "";
}
function updateColorBars(node) {
  for (const k of Object.values(COLOR_KINDS)) {
    const c = node ? inlineColorAt(node, k.prop) : "";
    k.btn.querySelector(".tb-bar").style.fill = c && c !== SENTINEL ? c : "";
    k.current = c;
  }
}
// Replace sentinel colors: drop them, or neutralize an outer color they sit inside.
function cleanSentinels() {
  for (const k of Object.values(COLOR_KINDS)) {
    editor.querySelectorAll("[style]").forEach((el) => {
      if (el.style[k.prop] !== SENTINEL) return;
      const outer = el.parentElement && el.parentElement !== editor && inlineColorAt(el.parentElement, k.prop);
      el.style[k.prop] = outer ? (k.prop === "color" ? "var(--text)" : "transparent") : "";
      if (!el.getAttribute("style").trim()) {
        if (el.tagName === "SPAN") el.replaceWith(...el.childNodes);
        else el.removeAttribute("style");
      }
    });
  }
}
function applyColor(k, color) {
  editor.focus();
  document.execCommand("styleWithCSS", false, true); // <span style> instead of <font>
  document.execCommand(k.cmd, false, color || SENTINEL);
  document.execCommand("styleWithCSS", false, false); // keep <b>/<i>/<u> for the other buttons
  cleanSentinels();
  scheduleSave();
  updateToolbarState();
}
function closeColorMenus() {
  for (const k of Object.values(COLOR_KINDS)) { k.menu.classList.add("hidden"); k.btn.setAttribute("aria-expanded", "false"); }
}
for (const k of Object.values(COLOR_KINDS)) {
  const grid = document.createElement("div");
  grid.className = "swatches";
  for (const c of k.colors) {
    const s = document.createElement("button");
    s.className = "swatch"; s.style.background = c; s.title = c; s.setAttribute("role", "menuitem");
    s.addEventListener("mousedown", (e) => { e.preventDefault(); closeColorMenus(); applyColor(k, c); });
    grid.append(s);
  }
  const reset = document.createElement("button");
  reset.className = "reset"; reset.textContent = k.resetLabel; reset.setAttribute("role", "menuitem");
  reset.addEventListener("mousedown", (e) => { e.preventDefault(); closeColorMenus(); applyColor(k, null); });
  k.menu.append(grid, reset);
  k.btn.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep the text selection
    const open = k.menu.classList.contains("hidden");
    closeColorMenus();
    if (!open) return;
    k.menu.querySelectorAll(".swatch").forEach((s) =>
      s.classList.toggle("current", !!k.current && s.style.backgroundColor === k.current));
    k.menu.classList.remove("hidden");
    k.btn.setAttribute("aria-expanded", "true");
  });
}
document.addEventListener("mousedown", (e) => { if (!e.target.closest(".color-wrap")) closeColorMenus(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !document.querySelector(".color-menu:not(.hidden)")) return;
  e.stopImmediatePropagation(); // Escape closes the menu instead of leaving the note
  closeColorMenus();
}, true);
editor.addEventListener("input", cleanSentinels); // text typed after "remove color" at a caret
document.addEventListener("selectionchange", updateToolbarState);
editor.addEventListener("keyup", updateToolbarState);
$("#checkBtn").addEventListener("mousedown", (e) => {
  e.preventDefault();
  const sel = getSelection();
  const inList = sel.anchorNode && sel.anchorNode.parentElement?.closest("ul.checklist");
  if (inList) return;
  document.execCommand("insertUnorderedList");
  const ul = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest("ul");
  if (ul) ul.classList.add("checklist");
  scheduleSave();
  updateToolbarState();
});

// ---------- indent / outdent ----------
// In a list: nest / un-nest the item. Elsewhere: insert / remove a 4-space tab at the caret.
const TAB = "\u00a0".repeat(4);
const LINE_BLOCKS = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|UL|OL)$/;

// The first text node of every line the selection touches (lines are split by <br> or block elements).
function selectedLineStarts(range) {
  const blockOf = (n) => { let e = n.parentElement; while (e !== editor && !LINE_BLOCKS.test(e.tagName)) e = e.parentElement; return e; };
  const atOrAfter = (n, o, n2, o2) => { const r = document.createRange(); r.setStart(n, o); return r.comparePoint(n2, o2) >= 0; };
  const starts = [];
  const w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let prev = null, brk = true;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === 1) { if (n.tagName === "BR") brk = true; continue; }
    if (!n.data.replace(/[\r\n]/g, "")) continue;
    if (brk || !prev || blockOf(prev) !== blockOf(n)) starts.push(n);
    prev = n; brk = false;
  }
  const { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo } = range;
  let first = -1;
  starts.forEach((s, i) => { if (atOrAfter(s, 0, sc, so)) first = i; }); // line holding the selection start
  return starts.filter((s, i) =>
    i === first || (i > first && atOrAfter(sc, so, s, 0) && !atOrAfter(ec, eo, s, 0)) // starts before the selection end
  ).filter((s) => !s.parentElement.closest("li"));
}

// Indent / outdent every line in a multi-line selection. Returns false if the selection is on one line.
function indentLines(sel, out) {
  const range = sel.getRangeAt(0);
  const lines = selectedLineStarts(range);
  if (lines.length < 2) return false;
  const { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo } = range;
  const delta = new Map();
  for (const t of [...lines].reverse()) { // bottom-up so earlier positions stay valid; execCommand keeps undo working
    if (out) {
      const m = t.data.match(/^[\u00a0 \t]{1,4}/);
      if (!m) continue;
      sel.setBaseAndExtent(t, 0, t, m[0].length);
      document.execCommand("delete");
      delta.set(t, -m[0].length);
    } else {
      sel.collapse(t, 0);
      document.execCommand("insertText", false, TAB);
      delta.set(t, TAB.length);
    }
  }
  const fix = (n, o) => {
    if (!delta.has(n)) return o;
    const d = delta.get(n);
    return Math.min(n.data.length, Math.max(0, d > 0 && o === 0 ? 0 : o + d));
  };
  try {
    const first = lines[0];
    const [an, ao] = sc.isConnected ? [sc, fix(sc, so)] : [first, 0];
    sel.setBaseAndExtent(an, ao, ec, fix(ec, eo));
  } catch {}
  return true;
}
function indent(out) {
  const sel = getSelection();
  const n = sel.anchorNode;
  const el = n && (n.nodeType === 1 ? n : n.parentElement);
  if (!el || !editor.contains(el)) return;
  if (el.closest("li")) {
    document.execCommand(out ? "outdent" : "indent");
    // nested lists created inside a checklist stay checklists
    editor.querySelectorAll("ul.checklist ul:not(.checklist)").forEach((u) => u.classList.add("checklist"));
  } else {
    if (!sel.isCollapsed && indentLines(sel, out)) { scheduleSave(); updateToolbarState(); return; }
    if (!sel.isCollapsed) sel.collapseToStart();
    if (!out) document.execCommand("insertText", false, TAB);
    else {
      const r = sel.getRangeAt(0);
      const before = r.startContainer.nodeType === 3 ? r.startContainer.data.slice(0, r.startOffset) : "";
      const m = before.match(/[\u00a0 \t]{1,4}$/);
      if (m) for (let i = 0; i < m[0].length; i++) document.execCommand("delete");
    }
  }
  scheduleSave();
  updateToolbarState();
}

// ---------- horizontal line ----------
// Typing "---" on an empty line turns it into a horizontal line (Ctrl+Z turns it back).
editor.addEventListener("input", (e) => {
  if (e.inputType !== "insertText" || e.data !== "-") return;
  const sel = getSelection();
  if (!sel.isCollapsed) return;
  const t = sel.anchorNode;
  if (!t || t.nodeType !== 3 || t.data !== "---" || sel.anchorOffset !== 3) return;
  const isLineEdge = (n) => !n || (n.nodeType === 1 && (n.tagName === "BR" || LINE_BLOCKS.test(n.tagName)));
  if (!isLineEdge(t.previousSibling) || !isLineEdge(t.nextSibling)) return; // "---" must be the whole line
  const p = t.parentElement;
  if (p !== editor && !/^(DIV|P)$/.test(p.tagName)) return; // not inside lists, code, bold, etc.
  sel.setBaseAndExtent(t, 0, t, 3);
  insertUndoable("<hr><div data-caret><br></div>");
});

// ---------- buttons & keys ----------
editor.addEventListener("input", scheduleSave);
titleInput.addEventListener("input", scheduleSave);
titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); editor.focus(); } });
$("#newBtn").onclick = () => createNote();
$("#backBtn").onclick = showList;
pinBtn.onclick = async () => {
  current.pinned = !current.pinned;
  pinBtn.textContent = current.pinned ? "★" : "☆";
  pinBtn.title = current.pinned ? "Remove from Favorites" : "Add to Favorites";
  await putNote(current);
};
$("#deleteBtn").onclick = async () => {
  if (!current) return;
  clearTimeout(saveTimer);
  const n = { ...current, title: titleInput.value.trim(), html: editor.innerHTML.replace(/ class="selected"/g, "") };
  current = null;
  await trashNote(n);
  showList();
};
search.addEventListener("input", renderList);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#lightbox").classList.contains("hidden")) { $("#lightbox").classList.add("hidden"); return; }
  if (e.key === "Escape" && current && selectedImgs().length) { clearImgSelection(); return; }
  if (e.key === "Escape" && current) showList();
  else if (e.key === "Escape" && view !== "all" && !e.target.closest?.("input")) goUp(); // back out of folders
  if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); createNote(); }
});
window.addEventListener("pagehide", flushSave);

// ---------- export / import ----------
$("#exportBtn").onclick = async () => {
  const notes = await getAllNotes();
  await loadFolders();
  const blob = new Blob([JSON.stringify({ app: "snap-notes", version: 1, folders, notes }, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `snap-notes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("#importInput").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const notes = Array.isArray(data) ? data : data.notes;
    const batch = {};
    for (const n of notes) if (n && n.id) batch[key(n.id)] = { ...n, html: sanitize(n.html || "", true) };
    if (Array.isArray(data.folders)) { // merge folders by id
      await loadFolders();
      for (const f of data.folders) if (f && f.id && typeof f.name === "string" && !folderById(f.id)) folders.push({ id: f.id, name: f.name });
      batch.folders = folders;
    }
    await chrome.storage.local.set(batch);
    renderList();
  } catch (err) { alert("Couldn't import that file: " + err.message); }
  e.target.value = "";
};

// ---------- right-click "Add to Note Sidekick" inbox ----------
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
async function drainInbox() {
  const { inbox = [] } = await chrome.storage.local.get("inbox");
  if (!inbox.length) return;
  await chrome.storage.local.set({ inbox: [] });
  if (!current) await createNote();
  for (const item of inbox) {
    if (item.type === "text") {
      const block = document.createElement("div");
      block.innerHTML = `<blockquote>${esc(item.text)}</blockquote><div><a href="${esc(item.source)}" target="_blank">source</a></div><div><br></div>`;
      insertNodeAtCursor(block);
    } else if (item.type === "image") {
      let src = item.src;
      try { // store a copy if the browser allows reading it; otherwise link to the original
        const r = await fetch(src);
        if (r.ok) src = await fileToDataURL(await r.blob());
      } catch {}
      insertImage(src);
    }
  }
  scheduleSave();
}
chrome.storage.onChanged.addListener((changes) => {
  if (changes.inbox?.newValue?.length) drainInbox();
  else if (!current && Object.keys(changes).some((k) => k.startsWith("note:") || k === "folders")) renderList(); // sync across windows
});

// ---------- start ----------
$("#emptyTrashBtn").onclick = emptyTrash;
purgeOldDeleted().then(renderList).then(drainInbox);
