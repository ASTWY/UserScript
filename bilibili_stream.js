// ==UserScript==
// @name         Bilibili 直播流获取助手
// @namespace    http://tampermonkey.net/
// @version      1
// @description  在B站直播间下方添加按钮，探测全策略最高画质直播流，并在前端弹出可视化窗口供展示和一键复制。
// @author       ASTWY
// @match        https://live.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_notification
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

(function () {
    'use-strict';

    let buttonCreationInterval = null;
    const ICON_ID = 'bili-stream-fetch-icon-wrapper';
    const MODAL_ID = 'bili-stream-result-modal';

    // SVG 图标: "获取链接"
    const ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72"></path>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.72"></path>
        </svg>
    `;

    /**
     * 1. 创建播放器下方的触发按钮
     */
    function createFetchIcon() {
        if (document.getElementById(ICON_ID)) return;
        const targetContainer = document.querySelector('.left-ctnr');
        if (!targetContainer) return;

        const iconWrapper = document.createElement('div');
        iconWrapper.id = ICON_ID;
        iconWrapper.innerHTML = ICON_SVG;
        iconWrapper.title = '获取并展示直播流地址';

        Object.assign(iconWrapper.style, {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '32px', height: '32px', marginLeft: '10px',
            cursor: 'pointer', color: '#61666D',
            transition: 'color 0.2s, opacity 0.3s',
        });

        iconWrapper.onmouseover = () => { if (!iconWrapper.classList.contains('loading')) iconWrapper.style.color = '#00A1D6'; };
        iconWrapper.onmouseout = () => { iconWrapper.style.color = '#61666D'; };
        iconWrapper.addEventListener('click', fetchLiveStream);

        targetContainer.appendChild(iconWrapper);
    }

    /**
     * 构建 API 请求 URL
     */
    function buildApiUrl(roomId, qn) {
        const params = new URLSearchParams({
            room_id: roomId, protocol: '0,1', format: '0,1,2', codec: '0,1,2',
            qn: qn, platform: 'web', ptype: '8', dolby: '5',
            panorama: '1', hdr_type: '0,1,6', supported_drms: '0,1,2,3'
        });
        return `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${params.toString()}`;
    }

    async function fetchWithCreds(url) {
        const res = await fetch(url, { credentials: 'include' });
        return await res.json();
    }

    /**
     * 2. 探针模式核心获取逻辑
     */
    async function fetchLiveStream() {
        const iconWrapper = document.getElementById(ICON_ID);
        if (!iconWrapper || iconWrapper.classList.contains('loading')) return;

        try {
            iconWrapper.classList.add('loading');
            iconWrapper.style.opacity = '0.5';
            iconWrapper.style.pointerEvents = 'none';

            // 获取房间号
            const match = window.location.pathname.match(/\/(?:blanc\/)?(\d+)/);
            if (!match || !match[1]) throw new Error('未能在URL中找到房间号');
            const shortRoomId = match[1];

            const initData = await fetchWithCreds(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${shortRoomId}`);
            if (initData.code !== 0) throw new Error(`获取房间信息失败: ${initData.message}`);
            if (initData.data.live_status !== 1) throw new Error('该直播间当前未开播');
            const realRoomId = initData.data.room_id;

            // Phase 1: 探路 (Probe)
            const probeData = await fetchWithCreds(buildApiUrl(realRoomId, 0));
            if (probeData.code !== 0) throw new Error(`探路失败: ${probeData.message}`);

            const playurlObj = probeData.data.playurl_info.playurl;
            const qnMap = {};
            playurlObj.g_qn_desc.forEach(item => { if (!qnMap[item.qn]) qnMap[item.qn] = item.desc; });

            let targetQn = 0;
            playurlObj.stream.forEach(p => p.format.forEach(f => f.codec.forEach(c => {
                if (c.accept_qn && c.accept_qn[0] > targetQn) targetQn = c.accept_qn[0];
            })));
            const targetQualityName = qnMap[targetQn] || `QN_${targetQn}`;

            // Phase 2: 获取 (Fetch)
            const finalData = await fetchWithCreds(buildApiUrl(realRoomId, targetQn));
            if (finalData.code !== 0) throw new Error(`获取目标流失败: ${finalData.message}`);

            // 解析并在前端展示
            processAndDisplayStreams(finalData.data.playurl_info.playurl, qnMap, targetQualityName);

        } catch (error) {
            console.error('[B站直播助手]', error);
            GM_notification({ text: error.message, title: '提取失败', timeout: 3000 });
        } finally {
            if (iconWrapper) {
                iconWrapper.classList.remove('loading');
                iconWrapper.style.opacity = '1';
                iconWrapper.style.pointerEvents = 'auto';
            }
        }
    }

    /**
     * 3. 提取数据并构建 UI 弹窗
     */
    function processAndDisplayStreams(playurlObj, qnMap, targetQualityName) {
        let streamCount = 0;
        const strategies = [];

        // 纯文本备份 (用于一键复制全部)
        let rawText = `================ B站直播流地址 ================\n目标画质: ${targetQualityName}\n\n`;

        playurlObj.stream.forEach(proto => {
            proto.format.forEach(fmt => {
                fmt.codec.forEach(codec => {
                    const currentQn = codec.current_qn;
                    const qualityDesc = (qnMap[currentQn] || `QN_${currentQn}`);

                    const stratInfo = {
                        title: `【${proto.protocol_name.toUpperCase()} / ${fmt.format_name.toUpperCase()} / ${codec.codec_name.toUpperCase()}】`,
                        quality: qualityDesc,
                        urls: []
                    };

                    rawText += `${stratInfo.title}\n ├─ 实际画质: ${qualityDesc}\n`;

                    codec.url_info.forEach((info, index) => {
                        const fullUrl = `${info.host}${codec.base_url}${info.extra}`;
                        stratInfo.urls.push(fullUrl);
                        rawText += ` ${index === codec.url_info.length - 1 ? '└─' : '├─'} 节点 ${index + 1}: ${fullUrl}\n`;
                        streamCount++;
                    });

                    rawText += `\n`;
                    strategies.push(stratInfo);
                });
            });
        });

        if (streamCount === 0) throw new Error('未解析到任何播放节点');

        // 调用弹窗渲染函数
        renderModalUI(strategies, targetQualityName, rawText, streamCount);
    }

    /**
     * 4. 渲染前端展示弹窗
     */
    function renderModalUI(strategies, targetQualityName, rawText, streamCount) {
        // 清理旧弹窗
        const oldOverlay = document.getElementById(MODAL_ID);
        if (oldOverlay) oldOverlay.remove();

        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.id = MODAL_ID;
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            backgroundColor: 'rgba(0, 0, 0, 0.65)', zIndex: '999999',
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
        });

        // 创建主面板
        const modal = document.createElement('div');
        Object.assign(modal.style, {
            backgroundColor: '#ffffff', borderRadius: '12px', width: '800px', maxWidth: '90%',
            maxHeight: '85vh', display: 'flex', flexDirection: 'column',
            boxShadow: '0 10px 30px rgba(0,0,0,0.3)', color: '#333', overflow: 'hidden'
        });

        // Header
        const header = document.createElement('div');
        header.style = "padding: 16px 24px; border-bottom: 1px solid #e5e9ef; display: flex; justify-content: space-between; align-items: center; background-color: #f4f5f7;";
        header.innerHTML = `
            <h3 style="margin:0; font-size: 18px; color: #222;">解析结果 <span style="font-size:14px; font-weight:normal; color:#00A1D6; margin-left: 8px;">(目标画质: ${targetQualityName} | 共 ${streamCount} 条)</span></h3>
            <button id="bili-modal-close" style="border:none; background:none; font-size:24px; cursor:pointer; color:#999; line-height:1;">&times;</button>
        `;

        // Body (滚动区域)
        const body = document.createElement('div');
        body.style = "padding: 20px 24px; overflow-y: auto; flex: 1;";

        strategies.forEach(strat => {
            const block = document.createElement('div');
            block.style = "margin-bottom: 20px; padding: 16px; background: #f6f8fa; border-radius: 8px; border: 1px solid #e1e4e8;";

            block.innerHTML = `<div style="font-weight: bold; margin-bottom: 12px; font-size: 14px;">
                <span style="color:#fb7299;">${strat.title}</span>
                <span style="margin-left:12px; color:#666;">实际提供画质: <span style="color:#333;">${strat.quality}</span></span>
            </div>`;

            strat.urls.forEach((url, idx) => {
                const row = document.createElement('div');
                row.style = "display: flex; margin-bottom: 8px; align-items: center;";

                // 输入框允许用户手动全选/拖拽复制
                row.innerHTML = `
                    <span style="font-size:13px; color:#555; min-width: 50px;">节点 ${idx + 1}</span>
                    <input type="text" value="${url}" readonly onclick="this.select()"
                           style="flex:1; padding: 6px 10px; border: 1px solid #d1d5da; border-radius: 4px; margin: 0 12px; font-size: 12px; color: #24292e; background:#fff; outline:none;">
                    <button class="bili-modal-copy-btn" data-url="${url}"
                            style="padding: 6px 16px; cursor:pointer; background:#00A1D6; color:#fff; border:none; border-radius:4px; font-size:13px; transition: background 0.2s;">
                        复制
                    </button>
                `;
                block.appendChild(row);
            });
            body.appendChild(block);
        });

        // Footer
        const footer = document.createElement('div');
        footer.style = "padding: 16px 24px; border-top: 1px solid #e5e9ef; text-align: right; background-color: #fafbfc;";
        footer.innerHTML = `<button id="bili-modal-copy-all" style="padding: 10px 24px; background:#fb7299; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size: 14px; font-weight: bold; transition: background 0.2s;">一键复制全部纯文本</button>`;

        // 组装 DOM
        modal.appendChild(header);
        modal.appendChild(body);
        modal.appendChild(footer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // 绑定事件
        document.getElementById('bili-modal-close').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        // 单独复制按钮功能
        const singleCopyBtns = overlay.querySelectorAll('.bili-modal-copy-btn');
        singleCopyBtns.forEach(btn => {
            btn.onclick = () => {
                GM_setClipboard(btn.getAttribute('data-url'), 'text');
                const origText = btn.innerText;
                btn.innerText = "已复制 ✓";
                btn.style.background = "#28a745"; // 绿色成功状态
                setTimeout(() => {
                    btn.innerText = origText;
                    btn.style.background = "#00A1D6";
                }, 1500);
            };
            // 按钮悬停变色效果
            btn.onmouseover = () => { if (btn.innerText === "复制") btn.style.background = "#0090c0"; };
            btn.onmouseout = () => { if (btn.innerText === "复制") btn.style.background = "#00A1D6"; };
        });

        // 复制全部功能
        const copyAllBtn = document.getElementById('bili-modal-copy-all');
        copyAllBtn.onclick = () => {
            GM_setClipboard(rawText, 'text');
            copyAllBtn.innerText = "全部文本已复制！ ✓";
            copyAllBtn.style.background = "#28a745";
            setTimeout(() => {
                copyAllBtn.innerText = "一键复制全部纯文本";
                copyAllBtn.style.background = "#fb7299";
            }, 2000);
        };
        copyAllBtn.onmouseover = () => { if (copyAllBtn.style.background === "rgb(251, 114, 153)") copyAllBtn.style.background = "#f25d8e"; };
        copyAllBtn.onmouseout = () => { if (copyAllBtn.style.background === "rgb(242, 93, 142)") copyAllBtn.style.background = "#fb7299"; };
    }

    // 初始化及页面跳转路由监听逻辑
    function initialize() {
        if (buttonCreationInterval) clearInterval(buttonCreationInterval);
        const isLivePage = /^https:\/\/live\.bilibili\.com\/(\d+|blanc\/\d+)/.test(window.location.href);

        if (isLivePage) {
            buttonCreationInterval = setInterval(() => {
                if (document.querySelector('.left-ctnr')) {
                    clearInterval(buttonCreationInterval);
                    createFetchIcon();
                }
            }, 500);
        } else {
            const oldIcon = document.getElementById(ICON_ID);
            if (oldIcon) oldIcon.remove();
        }
    }

    let lastHref = document.location.href;
    const observer = new MutationObserver(() => {
        if (document.location.href !== lastHref) {
            lastHref = document.location.href;
            initialize();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    initialize();
})();