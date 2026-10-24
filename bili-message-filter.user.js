// ==UserScript==
// @name         B站消息与评论本地折叠原型
// @namespace    local.bili.message.filter
// @version      0.4.0
// @description  可逆地折叠自选评论，不调用 B站互动接口
// @match        https://bilibili.com/*
// @match        https://*.bilibili.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      hdslb.com
// ==/UserScript==

(() => {
  'use strict';

  const MESSAGE_SELECTOR = '.reply-item';
  const LEGACY_MAIN_SELECTOR = '.reply-list > .reply-item > .root-reply-container';
  const LEGACY_SUB_SELECTOR = '.sub-reply-list > .sub-reply-item';
  const OLD_MAIN_SELECTOR = '.comment-list .list-item > .con';
  const OLD_SUB_SELECTOR = '.comment-list .reply-item > .reply-con';
  const KEYS = {
    blockedUids: 'baf.blockedUids.v1',
    blockedNames: 'baf.blockedNames.v1',
    allowedUids: 'baf.allowedUids.v1',
    allowedNames: 'baf.allowedNames.v1',
    heuristicEnabled: 'baf.heuristicEnabled.v1',
    avatarSamples: 'baf.avatarSamples.v1',
    shareMentionTarget: 'baf.shareMentionTarget.v1',
  };
  const readSet = key => {
    try {
      const value = GM_getValue(key, []);
      return new Set(Array.isArray(value) ? value.map(String) : []);
    } catch {
      return new Set();
    }
  };
  const rules = {
    blockedUids: readSet(KEYS.blockedUids),
    blockedNames: readSet(KEYS.blockedNames),
    allowedUids: readSet(KEYS.allowedUids),
    allowedNames: readSet(KEYS.allowedNames),
  };
  const avatarSamples = readSet(KEYS.avatarSamples);
  for (const sample of avatarSamples) {
    if (!/^[0-9a-f]{16}:[0-9a-f]{16}$/u.test(sample)) avatarSamples.delete(sample);
  }
  const avatarCache = new Map();
  const avatarJobs = new Map();
  const avatarQueue = [];
  let activeAvatarJobs = 0;
  const cardStates = new WeakMap();
  const commentStates = new WeakMap();
  const trackedComments = new Set();
  const observedRoots = new WeakSet();
  const shadowObserver = new MutationObserver(scheduleScan);
  let heuristicEnabled = GM_getValue(KEYS.heuristicEnabled, true) !== false;
  let shareMentionTarget = String(GM_getValue(KEYS.shareMentionTarget, '') || '').trim().replace(/^@/u, '');
  let scanScheduled = false;

  function save(name) {
    GM_setValue(KEYS[name], [...rules[name]]);
  }

  function isReplyPage() {
    return location.hostname === 'message.bilibili.com' && /^#\/reply(?:$|[/?])/.test(location.hash);
  }

  function isVideoPage() {
    return (location.hostname === 'www.bilibili.com' || location.hostname === 'bilibili.com')
      && location.pathname.startsWith('/video/');
  }

  function clearShareMentionTarget() {
    shareMentionTarget = '';
    GM_setValue(KEYS.shareMentionTarget, '');
    scheduleScan();
  }

  function extract(card) {
    const user = card.querySelector('.name-field a');
    const content = card.querySelector('.text');
    const name = user?.textContent?.trim();
    const text = content?.textContent?.trim();
    if (!name || !text) return null;
    const uid = user.href.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? '';
    return { uid, name, text, avatarUrl: avatarUrlFrom(card.querySelector('img.avatar, .avatar img, .face img')) };
  }

  function avatarUrlFrom(image) {
    const raw = image?.currentSrc || image?.getAttribute('src');
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      return url.protocol === 'https:' && /(^|\.)hdslb\.com$/u.test(url.hostname)
        && url.pathname.startsWith('/bfs/face/') ? url.href : '';
    } catch {
      return '';
    }
  }

  function imageHash(bitmap, crop) {
    const canvas = document.createElement('canvas');
    canvas.width = 9;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return '';
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 9, 8);
    const width = bitmap.width || 9;
    const height = bitmap.height || 8;
    const insetX = width * crop;
    const insetY = height * crop;
    context.drawImage(bitmap, insetX, insetY, width - 2 * insetX, height - 2 * insetY, 0, 0, 9, 8);
    const pixels = context.getImageData(0, 0, 9, 8).data;
    let hash = 0n;
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const a = (y * 9 + x) * 4;
        const b = a + 4;
        const left = pixels[a] * 299 + pixels[a + 1] * 587 + pixels[a + 2] * 114;
        const right = pixels[b] * 299 + pixels[b + 1] * 587 + pixels[b + 2] * 114;
        hash = (hash << 1n) | BigInt(left > right);
      }
    }
    return hash.toString(16).padStart(16, '0');
  }

  function requestAvatar(url) {
    return new Promise(resolve => {
      if (typeof GM_xmlhttpRequest !== 'function') return resolve(null);
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: 8000,
        onload: response => resolve(response.status === 200 ? response.response : null),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  async function hashImage(image) {
    if (!image || (image.size && image.size > 2_000_000) || typeof createImageBitmap !== 'function') return null;
    let bitmap;
    try {
      bitmap = await createImageBitmap(image);
      const full = imageHash(bitmap, 0);
      const center = imageHash(bitmap, 0.05);
      return full && center ? `${full}:${center}` : null;
    } catch {
      return null;
    } finally {
      bitmap?.close?.();
    }
  }

  async function loadAvatarHash(url) {
    return hashImage(await requestAvatar(url));
  }

  function pumpAvatarQueue() {
    while (activeAvatarJobs < 3 && avatarQueue.length) {
      const { url, resolve } = avatarQueue.shift();
      activeAvatarJobs += 1;
      loadAvatarHash(url).then(hash => {
        avatarCache.set(url, hash);
        if (avatarCache.size > 500) avatarCache.delete(avatarCache.keys().next().value);
        resolve(hash);
      }).catch(() => {
        avatarCache.set(url, null);
        resolve(null);
      }).finally(() => {
        avatarJobs.delete(url);
        activeAvatarJobs -= 1;
        scheduleScan();
        pumpAvatarQueue();
      });
    }
  }

  function getAvatarHash(url) {
    if (!url) return Promise.resolve(null);
    if (avatarCache.has(url)) return Promise.resolve(avatarCache.get(url));
    if (avatarJobs.has(url)) return avatarJobs.get(url);
    const job = new Promise(resolve => avatarQueue.push({ url, resolve }));
    avatarJobs.set(url, job);
    pumpAvatarQueue();
    return job;
  }

  function hashDistance(a, b) {
    let difference = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
    let count = 0;
    while (difference) {
      difference &= difference - 1n;
      count += 1;
    }
    return count;
  }

  function matchingAvatarSample(hash) {
    if (!hash) return '';
    const candidates = hash.split(':');
    for (const sample of avatarSamples) {
      const reference = sample.split(':');
      if (candidates.some(part => reference.some(item => hashDistance(part, item) <= 6))) return sample;
    }
    return '';
  }

  function saveAvatarSamples() {
    GM_setValue(KEYS.avatarSamples, [...avatarSamples]);
    scheduleScan();
  }

  function removeMatchingAvatarSample(info) {
    const hash = avatarCache.get(info.avatarUrl);
    const sample = matchingAvatarSample(hash);
    if (sample) {
      avatarSamples.delete(sample);
      saveAvatarSamples();
    }
  }

  function match(info) {
    if ((info.uid && rules.blockedUids.has(info.uid)) || rules.blockedNames.has(info.name)) {
      return { kind: 'blocked', reason: '你已在本地屏蔽此人' };
    }
    if ((info.uid && rules.allowedUids.has(info.uid)) || rules.allowedNames.has(info.name)) {
      return null;
    }
    if (!heuristicEnabled) return null;
    if (info.videoMain && shareMentionTarget) {
      const content = info.text.trimStart();
      const prefix = `@${shareMentionTarget}`;
      if (content.startsWith(prefix) && /^(?:\s|$)/u.test(content.slice(prefix.length))) {
        return { kind: 'candidate', reason: '你设置的 @对象开头的视频主评论' };
      }
    }
    if (info.avatarUrl && avatarSamples.size) {
      if (!avatarCache.has(info.avatarUrl)) void getAvatarHash(info.avatarUrl);
      const sample = matchingAvatarSample(avatarCache.get(info.avatarUrl));
      if (sample) return { kind: 'candidate', reason: '头像与本地样本相似' };
    }
    if (/[鱼鲸]/u.test(info.name) && info.text.length >= 35) {
      return { kind: 'candidate', reason: '昵称含鱼／鲸，且评论较长' };
    }
    return null;
  }

  function identifySet(info, type) {
    return info.uid ? `${type}Uids` : `${type}Names`;
  }

  function identifyValue(info) {
    return info.uid || info.name;
  }

  function updateRule(info, type, add) {
    const key = identifySet(info, type);
    const value = identifyValue(info);
    if (add) rules[key].add(value);
    else rules[key].delete(value);
    save(key);
    scheduleScan();
  }

  function button(label, action, handler) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'baf-button';
    element.dataset.bafAction = action;
    element.textContent = label;
    element.style.cssText = 'margin-left:6px;padding:2px 7px;border:1px solid #90adc6;border-radius:4px;background:white;color:#236189;cursor:pointer;font-size:12px';
    element.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      handler();
    });
    return element;
  }

  function ensureAvatarControl(user, info, reextract) {
    const parent = user.parentNode;
    let control = parent.querySelector('[data-baf-action="avatar-sample"]');
    if (!info.avatarUrl) {
      control?.remove();
      return;
    }
    if (!control) {
      control = button('以此头像为样本', 'avatar-sample', async () => {
        const current = reextract();
        if (!current?.avatarUrl) return;
        control.disabled = true;
        control.textContent = '读取头像中…';
        const hash = await getAvatarHash(current.avatarUrl);
        control.disabled = false;
        if (!hash) {
          control.textContent = '头像读取失败';
          return;
        }
        const sample = matchingAvatarSample(hash);
        if (sample) avatarSamples.delete(sample);
        else avatarSamples.add(hash);
        saveAvatarSamples();
      });
      user.after(control);
    }
    if (!control.disabled) {
      const label = matchingAvatarSample(avatarCache.get(info.avatarUrl))
        ? '移除匹配头像样本' : '以此头像为样本';
      if (control.textContent !== label) control.textContent = label;
    }
  }

  function ensureControls(card, info) {
    const user = card.querySelector('.name-field a');
    ensureAvatarControl(user, info, () => extract(card));
    if (!card.querySelector('[data-baf-action="block"]')) {
      user.after(button('本地屏蔽此人', 'block', () => {
        const current = extract(card);
        if (!current) return;
        updateRule(current, 'allowed', false);
        updateRule(current, 'blocked', true);
      }));
    }
    const allowed = (info.uid && rules.allowedUids.has(info.uid)) || rules.allowedNames.has(info.name);
    const undo = card.querySelector('[data-baf-action="unallow"]');
    if (allowed && !undo) {
      user.after(button('取消误判白名单', 'unallow', () => {
        const current = extract(card);
        if (current) updateRule(current, 'allowed', false);
      }));
    } else if (!allowed) {
      undo?.remove();
    }
  }

  function updateCard(card) {
    const info = extract(card);
    if (!info) return;
    ensureControls(card, info);
    let state = cardStates.get(card);
    if (!state) {
      state = { key: '', revealed: false, placeholder: null };
      cardStates.set(card, state);
    }
    const result = match(info);
    if (!result) {
      state.placeholder?.remove();
      state.placeholder = null;
      state.key = '';
      state.revealed = false;
      card.classList.remove('baf-collapsed');
      return;
    }
    const key = `${result.kind}:${result.reason}`;
    if (state.key !== key || !state.placeholder?.isConnected) {
      state.placeholder?.remove();
      state.revealed = false;
      state.key = key;
      const placeholder = document.createElement('div');
      placeholder.className = 'baf-placeholder';
      const description = document.createElement('span');
      description.textContent = `${result.kind === 'blocked' ? '本地屏蔽' : '疑似自动评论'} · ${info.name} · ${result.reason}`;
      placeholder.append(description);
      placeholder.append(button('展开', 'reveal', () => {
        state.revealed = !state.revealed;
        card.classList.toggle('baf-collapsed', !state.revealed);
        placeholder.querySelector('[data-baf-action="reveal"]').textContent = state.revealed ? '收起' : '展开';
      }));
      if (result.kind === 'blocked') {
        placeholder.append(button('取消本地屏蔽', 'unblock', () => {
          const current = extract(card);
          if (current) updateRule(current, 'blocked', false);
        }));
      } else {
        placeholder.append(button('误判，不再提示此人', 'allow', () => {
          const current = extract(card);
          if (current) updateRule(current, 'allowed', true);
        }));
        placeholder.append(button('本地屏蔽此人', 'block-candidate', () => {
          const current = extract(card);
          if (current) updateRule(current, 'blocked', true);
        }));
        if (result.reason === '头像与本地样本相似') {
          placeholder.append(button('移除此头像样本', 'remove-avatar-sample', () => {
            const current = extract(card);
            if (current) removeMatchingAvatarSample(current);
          }));
        }
      }
      card.prepend(placeholder);
      state.placeholder = placeholder;
    }
    card.classList.toggle('baf-collapsed', !state.revealed);
  }

  function uidFrom(user) {
    return user?.getAttribute('data-user-id') || user?.href?.match(/space\.bilibili\.com\/(\d+)/)?.[1] || '';
  }

  function extractLegacy(target, sub) {
    const user = target.querySelector(sub ? '.sub-user-name' : '.user-name');
    const content = target.querySelector('.reply-content');
    const name = user?.textContent?.trim();
    const text = content?.textContent?.trim();
    if (!user || !name || !text) return null;
    const avatarImage = sub
      ? target.querySelector('img.avatar, .avatar img, .user-face img')
      : target.querySelector('img.avatar, .avatar img, .root-reply-avatar img')
        || target.parentElement?.querySelector(':scope > .root-reply-avatar img, :scope > img.avatar');
    return { info: { uid: uidFrom(user), name, text, avatarUrl: avatarUrlFrom(avatarImage), videoMain: !sub && isVideoPage() }, user };
  }

  function extractOld(target) {
    const user = target.querySelector('.user a.name');
    const content = target.matches('.con') ? target.querySelector('p.text') : target.querySelector('.text-con');
    const name = user?.textContent?.trim();
    const text = content?.textContent?.trim();
    if (!user || !name || !text) return null;
    const avatarImage = target.querySelector('img.avatar, .avatar img, .user-face img')
      || target.parentElement?.querySelector(':scope > .user-face img');
    return { info: { uid: uidFrom(user), name, text, avatarUrl: avatarUrlFrom(avatarImage), videoMain: target.matches('.con') && isVideoPage() }, user };
  }

  function shadowAvatarImage(root) {
    const direct = root.querySelector('#user-avatar img, img.avatar');
    if (direct) return direct;
    const host = root.querySelector('bili-comment-avatar, bili-avatar, #user-avatar');
    let current = host;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const scope = current.shadowRoot || current;
      const image = scope.querySelector('img[src*="/bfs/face/"]');
      if (image) return image;
      current = scope.querySelector('bili-comment-avatar, bili-avatar, img-avatar');
      if (current === host) break;
    }
    return null;
  }

  function extractShadow(target) {
    const root = target.shadowRoot;
    if (!root) return null;
    const userHost = root.querySelector('bili-comment-user-info');
    const user = userHost?.shadowRoot?.querySelector('#user-name a')
      || root.querySelector('#header a[href*="space.bilibili.com/"]');
    let rich = root.querySelector('#content bili-rich-text') || root.querySelector('bili-rich-text');
    let text = '';
    for (let depth = 0; rich && depth < 4; depth += 1) {
      const richRoot = rich.shadowRoot;
      text = richRoot?.querySelector('#contents')?.textContent?.trim() || '';
      if (text) break;
      rich = richRoot?.querySelector('bili-rich-text');
    }
    const name = user?.textContent?.trim();
    if (!user || !name || !text) return null;
    return { info: { uid: uidFrom(user), name, text, avatarUrl: avatarUrlFrom(shadowAvatarImage(root)), videoMain: target.matches('bili-comment-renderer') && isVideoPage() }, user };
  }

  function ensureCommentControls(target, extraction) {
    const { info, user } = extraction;
    ensureAvatarControl(user, info, () => commentStates.get(target)?.extract(target)?.info);
    if (!target.querySelector?.('[data-baf-action="block-comment"]')
        && !user.parentNode.querySelector('[data-baf-action="block-comment"]')) {
      user.after(button('本地屏蔽此人', 'block-comment', () => {
        const current = commentStates.get(target)?.extract(target);
        if (!current) return;
        updateRule(current.info, 'allowed', false);
        updateRule(current.info, 'blocked', true);
      }));
    }
    const allowed = (info.uid && rules.allowedUids.has(info.uid)) || rules.allowedNames.has(info.name);
    const undo = user.parentNode.querySelector('[data-baf-action="unallow-comment"]');
    if (allowed && !undo) {
      user.after(button('取消误判白名单', 'unallow-comment', () => {
        const current = commentStates.get(target)?.extract(target);
        if (current) updateRule(current.info, 'allowed', false);
      }));
    } else if (!allowed) {
      undo?.remove();
    }
  }

  function resetComment(target, state) {
    state.placeholder?.remove();
    state.placeholder = null;
    state.key = '';
    state.revealed = false;
    target.classList.remove('baf-collapsed');
    target.style.display = state.originalDisplay;
  }

  function updateComment(target, extract) {
    const extraction = extract(target);
    if (!extraction || !target.parentNode) return;
    const { info } = extraction;
    let state = commentStates.get(target);
    if (!state) {
      state = { key: '', revealed: false, placeholder: null, originalDisplay: target.style.display, extract };
      commentStates.set(target, state);
      trackedComments.add(target);
    }
    state.extract = extract;
    ensureCommentControls(target, extraction);
    const result = match(info);
    if (!result) {
      if (state.key) resetComment(target, state);
      return;
    }
    const key = `${result.kind}:${result.reason}:${info.name}`;
    if (state.key !== key || state.placeholder?.parentNode !== target.parentNode) {
      state.placeholder?.remove();
      state.revealed = false;
      state.key = key;
      const placeholder = document.createElement('div');
      placeholder.className = 'baf-placeholder';
      placeholder.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px;border:1px solid #b8c8d8;border-radius:6px;background:#f5f9ff;color:#334;font-size:13px';
      const description = document.createElement('span');
      description.textContent = `${result.kind === 'blocked' ? '本地屏蔽' : '疑似自动评论'} · ${info.name} · ${result.reason}`;
      placeholder.append(description);
      placeholder.append(button('展开', 'reveal-comment', () => {
        state.revealed = !state.revealed;
        target.style.display = state.revealed ? state.originalDisplay : 'none';
        target.classList.toggle('baf-collapsed', !state.revealed);
        placeholder.querySelector('[data-baf-action="reveal-comment"]').textContent = state.revealed ? '收起' : '展开';
      }));
      if (result.kind === 'blocked') {
        placeholder.append(button('取消本地屏蔽', 'unblock-comment', () => {
          const current = state.extract(target);
          if (current) updateRule(current.info, 'blocked', false);
        }));
      } else {
        placeholder.append(button('误判，不再提示此人', 'allow-comment', () => {
          const current = state.extract(target);
          if (current) updateRule(current.info, 'allowed', true);
        }));
        placeholder.append(button('本地屏蔽此人', 'block-candidate-comment', () => {
          const current = state.extract(target);
          if (current) updateRule(current.info, 'blocked', true);
        }));
        if (result.reason === '头像与本地样本相似') {
          placeholder.append(button('移除此头像样本', 'remove-avatar-sample', () => {
            const current = state.extract(target);
            if (current) removeMatchingAvatarSample(current.info);
          }));
        }
        if (result.reason === '你设置的 @对象开头的视频主评论') {
          placeholder.append(button('关闭此 @对象规则', 'disable-share-target', clearShareMentionTarget));
        }
      }
      target.parentNode.insertBefore(placeholder, target);
      state.placeholder = placeholder;
    }
    target.classList.toggle('baf-collapsed', !state.revealed);
    target.style.display = state.revealed ? state.originalDisplay : 'none';
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    shadowObserver.observe(root, { childList: true, characterData: true, subtree: true });
    observedRoots.add(root);
  }

  function scanShadowRoot(root) {
    observeRoot(root);
    root.querySelectorAll('bili-comment-renderer, bili-comment-reply-renderer').forEach(target => {
      updateComment(target, extractShadow);
    });
    root.querySelectorAll('*').forEach(element => {
      if (element.shadowRoot) scanShadowRoot(element.shadowRoot);
    });
  }

  function scanComments() {
    document.querySelectorAll(LEGACY_MAIN_SELECTOR).forEach(target => updateComment(target, node => extractLegacy(node, false)));
    document.querySelectorAll(LEGACY_SUB_SELECTOR).forEach(target => updateComment(target, node => extractLegacy(node, true)));
    document.querySelectorAll(OLD_MAIN_SELECTOR).forEach(target => updateComment(target, extractOld));
    document.querySelectorAll(OLD_SUB_SELECTOR).forEach(target => updateComment(target, extractOld));
    document.querySelectorAll('bili-comments').forEach(host => {
      if (host.shadowRoot) scanShadowRoot(host.shadowRoot);
    });
    for (const target of trackedComments) {
      if (!target.isConnected) {
        const state = commentStates.get(target);
        state?.placeholder?.remove();
        trackedComments.delete(target);
      }
    }
  }

  function scan() {
    scanScheduled = false;
    if (location.hostname !== 'message.bilibili.com') {
      scanComments();
      return;
    }
    if (!isReplyPage()) {
      document.querySelectorAll(MESSAGE_SELECTOR).forEach(card => {
        const state = cardStates.get(card);
        state?.placeholder?.remove();
        if (state) {
          state.placeholder = null;
          state.key = '';
          state.revealed = false;
        }
        card.classList.remove('baf-collapsed');
        card.querySelectorAll('[data-baf-action="block"], [data-baf-action="unallow"], [data-baf-action="avatar-sample"]').forEach(control => control.remove());
      });
      return;
    }
    document.querySelectorAll(MESSAGE_SELECTOR).forEach(updateCard);
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(scan, 0);
  }

  function start() {
    const style = document.createElement('style');
    style.textContent = `
      .reply-item.baf-collapsed > :not(.baf-placeholder) { display: none !important; }
      .baf-placeholder { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px; border: 1px solid #b8c8d8; border-radius: 6px; background: #f5f9ff; color: #334; font-size: 13px; }
      .baf-button { margin-left: 6px; padding: 2px 7px; border: 1px solid #90adc6; border-radius: 4px; background: white; color: #236189; cursor: pointer; font-size: 12px; }
    `;
    document.head.append(style);
    const avatarInput = document.createElement('input');
    avatarInput.type = 'file';
    avatarInput.accept = 'image/*';
    avatarInput.dataset.bafAvatarImport = '';
    avatarInput.style.display = 'none';
    avatarInput.addEventListener('change', async () => {
      const file = avatarInput.files?.[0];
      avatarInput.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/') || file.size > 2_000_000) {
        alert('请选择不超过 2 MB 的头像图片。');
        return;
      }
      const hash = await hashImage(file);
      if (!hash) {
        alert('头像样本读取失败，请换一张图片重试。');
        return;
      }
      avatarSamples.add(hash);
      saveAvatarSamples();
    });
    document.body.append(avatarInput);
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('切换疑似消息／评论自动折叠', () => {
        heuristicEnabled = !heuristicEnabled;
        GM_setValue(KEYS.heuristicEnabled, heuristicEnabled);
        scheduleScan();
      });
      GM_registerMenuCommand('导入本地头像样本图片', () => avatarInput.click());
      GM_registerMenuCommand('清空本地头像样本', () => {
        if (!avatarSamples.size || !confirm(`清空 ${avatarSamples.size} 个本地头像样本？`)) return;
        avatarSamples.clear();
        saveAvatarSamples();
      });
      GM_registerMenuCommand('设置视频主评论开头 @对象（留空关闭）', () => {
        const raw = prompt('输入要折叠的开头 @对象昵称；留空则关闭。仅用于视频顶层评论，不代表 AI 身份。', shareMentionTarget);
        if (raw === null) return;
        const next = String(raw).trim().replace(/^@/u, '');
        if (next.length > 60 || /[\r\n]/u.test(next)) {
          alert('昵称不能超过 60 字，也不能包含换行。');
          return;
        }
        shareMentionTarget = next;
        GM_setValue(KEYS.shareMentionTarget, next);
        scheduleScan();
      });
    }
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, characterData: true, subtree: true });
    window.addEventListener('hashchange', scheduleScan);
    scheduleScan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
