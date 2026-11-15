// Snap Notes — side panel logic.
// Each note is stored in chrome.storage.local under "note:<id>":
//   { id, title, html, pinned, created, updated }
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
async function getAllNotes() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith("note:")).map(([, v]) => v);
}
const putNote = (n) => chrome.storage.local.set({ [key(n.id)]: n });
const removeNote = (id) => chrome.storage.local.remove(key(id));
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

async function renderList() {
  const q = search.value.trim().toLowerCase();
  let notes = await getAllNotes();
  $("#count").textContent = notes.length ? `(${notes.length})` : "";
  notes.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
  if (q) notes = notes.filter((n) => (n.title + " " + plainText(n.html)).toLowerCase().includes(q));

  noteList.innerHTML = "";
  $("#empty").classList.toggle("hidden", notes.length > 0);
  if (!notes.length && q) { $("#empty").textContent = "No notes match your search."; }
  else $("#empty").innerHTML = "No notes yet. Click <b>+ New</b> to start.";

  for (const n of notes) {
    const text = plainText(n.html);
    const li = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = (n.pinned ? "★ " : "") + (n.title || text.slice(0, 60) || "Untitled");
    const p = document.createElement("div");
    p.className = "p";
    p.textContent = n.title ? text : text.slice(60);
    const imgCount = (n.html.match(/<img/g) || []).length;
    const d = document.createElement("div");
    d.className = "d";
    d.textContent = fmtDate(n.updated) + (imgCount ? ` · ${imgCount} image${imgCount > 1 ? "s" : ""}` : "");
    meta.append(t, p, d);
    li.append(meta);
    const src = firstImage(n.html);
    if (src) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = src;
      li.append(img);
    }
    li.onclick = () => openNote(n);
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
  search.focus();
}
function openNote(n) {
  current = n;
  titleInput.value = n.title || "";
  editor.innerHTML = n.html || "";
  pinBtn.textContent = n.pinned ? "★" : "☆";
  saveState.textContent = "";
  listView.classList.add("hidden");
  editorView.classList.remove("hidden");
  editor.focus();
}
async function createNote(initialHtml = "") {
  const now = Date.now();
  const n = { id: newId(), title: "", html: initialHtml, pinned: false, created: now, updated: now };
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
function insertImage(src) {
  const img = document.createElement("img");
  img.src = src;
  const frag = document.createDocumentFragment();
  const after = document.createElement("div");
  after.innerHTML = "<br>";          // gives you a line to keep typing under the image
  frag.append(img, after);
  insertNodeAtCursor(frag);
  const sel = window.getSelection(), r = document.createRange();
  r.setStart(after, 0); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  scheduleSave();
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
function sanitize(html) {
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
// Separate images as HTML, so Docs, Gmail, Notion, Word and Snap Notes get each one individually.
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
  imgs.forEach((i) => i.remove());
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
  if (li && e.clientX - li.getBoundingClientRect().left < 22) {
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
  })
);
$("#checkBtn").addEventListener("mousedown", (e) => {
  e.preventDefault();
  const sel = getSelection();
  const inList = sel.anchorNode && sel.anchorNode.parentElement?.closest("ul.checklist");
  if (inList) return;
  document.execCommand("insertUnorderedList");
  const ul = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest("ul");
  if (ul) ul.classList.add("checklist");
  scheduleSave();
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
  await putNote(current);
};
$("#deleteBtn").onclick = async () => {
  if (!current) return;
  const isEmpty = !current.title && !plainText(editor.innerHTML) && !editor.querySelector("img");
  if (!isEmpty && !confirm("Delete this note?")) return;
  await removeNote(current.id);
  current = null;
  showList();
};
search.addEventListener("input", renderList);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#lightbox").classList.contains("hidden")) { $("#lightbox").classList.add("hidden"); return; }
  if (e.key === "Escape" && current && selectedImgs().length) { clearImgSelection(); return; }
  if (e.key === "Escape" && current) showList();
  if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); createNote(); }
});
window.addEventListener("pagehide", flushSave);

// ---------- export / import ----------
$("#exportBtn").onclick = async () => {
  const notes = await getAllNotes();
  const blob = new Blob([JSON.stringify({ app: "snap-notes", version: 1, notes }, null, 1)], { type: "application/json" });
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
    for (const n of notes) if (n && n.id) batch[key(n.id)] = { ...n, html: sanitize(n.html || "") };
    await chrome.storage.local.set(batch);
    renderList();
  } catch (err) { alert("Couldn't import that file: " + err.message); }
  e.target.value = "";
};

// ---------- right-click "Add to Snap Notes" inbox ----------
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
  else if (!current && Object.keys(changes).some((k) => k.startsWith("note:"))) renderList(); // sync across windows
});

// ---------- start ----------
renderList().then(drainInbox);
