const DURATION = 6_000;
const stage = document.querySelector(".stage");
const curtain = document.querySelector(".curtain");
const curtainCopy = document.querySelector(".curtain-copy");
const coverWall = document.querySelector(".cover-wall");
const mosaicWall = document.querySelector(".mosaic-wall");
let ready = false;
let finishTimer = 0;

boot().catch(error => {
  curtainCopy.innerHTML = `<strong>素材加载失败</strong><span>${escapeHtml(error.message)}</span>`;
});

async function boot() {
  const manifest = await fetch("../assets/manifest.json", { cache: "no-store" }).then(response => {
    if (!response.ok) throw new Error("请先运行 npm run promo:prepare");
    return response.json();
  });
  const covers = manifest.covers || [];
  const characters = manifest.characters || [];
  if (covers.length < 70 || characters.length < 70) throw new Error("封面或人物图不足，请重新准备素材");
  const urls = [...covers, ...characters].map(item => item.src);
  const loaded = await preload(urls, progress => {
    curtainCopy.innerHTML = `<strong>正在准备题库图片</strong><span>${progress} / ${urls.length}</span>`;
  });
  renderCovers(covers);
  renderMosaics(characters, loaded.slice(covers.length));
  ready = true;
  curtain.classList.add("ready");
  curtainCopy.innerHTML = "<strong>准备完成</strong><span>按 F 全屏 · 按空格播放</span>";
  showPreviewFrameFromUrl();
}

function showPreviewFrameFromUrl() {
  const frame = Number(new URLSearchParams(location.search).get("frame"));
  if (!Number.isFinite(frame) || frame < 0) return;
  curtain.hidden = true;
  document.body.classList.add("playing");
  void stage.offsetWidth;
  requestAnimationFrame(() => {
    document.getAnimations().forEach(animation => {
      animation.currentTime = Math.min(frame, DURATION);
      animation.pause();
    });
  });
}

function renderCovers(covers) {
  coverWall.replaceChildren(...makeColumns(covers, 5, (item) => {
    const card = document.createElement("div");
    card.className = "cover-card";
    const image = new Image();
    image.src = item.src;
    image.alt = "";
    image.draggable = false;
    card.append(image);
    return card;
  }, "cover"));
}

function renderMosaics(characters, loadedImages) {
  mosaicWall.replaceChildren(...makeColumns(characters, 5, (item, index) => {
    const card = document.createElement("div");
    card.className = "mosaic-card";
    const canvas = document.createElement("canvas");
    const sampleWidth = 18 + (index % 4) * 3;
    const sampleHeight = Math.round(sampleWidth / 0.82);
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ecece8";
    context.fillRect(0, 0, sampleWidth, sampleHeight);
    drawCover(context, loadedImages[index], sampleWidth, sampleHeight);
    card.append(canvas);
    return card;
  }, "mosaic"));
}

function makeColumns(items, count, createCard, type) {
  return Array.from({ length: count }, (_, columnIndex) => {
    const column = document.createElement("div");
    column.className = `${type}-column`;
    const start = type === "cover" ? -5 - (columnIndex % 3) * 2 : -18 - (columnIndex % 3) * 2;
    const end = type === "cover" ? -18 - (columnIndex % 3) * 2 : -5 - (columnIndex % 3) * 2;
    column.style.setProperty(`--${type}-start`, `${start}%`);
    column.style.setProperty(`--${type}-end`, `${end}%`);
    const columnItems = items
      .map((item, index) => ({ item, index }))
      .filter(({ index }) => index % count === columnIndex);
    column.replaceChildren(...columnItems.map(({ item, index }) => createCard(item, index)));
    return column;
  });
}

function drawCover(context, image, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function play() {
  if (!ready) return;
  clearTimeout(finishTimer);
  document.body.classList.remove("playing", "finished");
  void stage.offsetWidth;
  curtain.hidden = true;
  document.body.classList.add("playing");
  finishTimer = window.setTimeout(() => {
    document.body.classList.remove("playing");
    document.body.classList.add("finished");
  }, DURATION);
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  else await document.exitFullscreen();
}

document.addEventListener("keydown", event => {
  if (event.code === "Space") {
    event.preventDefault();
    play();
  }
  if (event.key.toLowerCase() === "f") toggleFullscreen().catch(() => {});
});
curtain.addEventListener("click", play);

async function preload(urls, onProgress) {
  let complete = 0;
  return Promise.all(urls.map(url => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { complete += 1; onProgress(complete); resolve(image); };
    image.onerror = () => reject(new Error(`无法加载 ${url}`));
    image.src = url;
  })));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}
