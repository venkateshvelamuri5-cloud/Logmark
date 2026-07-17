/**
 * ═══════════════════════════════════════════════════════════
 *  LOGMARK — Embedded Chat Widget Injector
 *  Drop this on any host site to add a floating chat assistant.
 * ═══════════════════════════════════════════════════════════
 */
(function() {
  // Prevent duplicate initialization
  if (window.__logmark_widget_loaded) return;
  window.__logmark_widget_loaded = true;

  // Retrieve parameters
  const profileId = window.LOGMARK_WIDGET_ID;
  const vercelUrl = window.LOGMARK_URL || 'https://www.logmark-ai.com';
  
  if (!profileId) {
    console.error('[Logmark Widget] Error: window.LOGMARK_WIDGET_ID is not configured.');
    return;
  }

  // Helper: Encrypt profile ID to URL-safe Base64
  function encryptProfileId(id) {
    try {
      return btoa(id).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    } catch(e) {
      return id;
    }
  }

  const encryptedId = encryptProfileId(profileId);
  const iframeSource = `${vercelUrl.replace(/\/$/, '')}/${encryptedId}/assistant`;

  function initWidget() {
    if (!document.body) {
      setTimeout(initWidget, 50);
      return;
    }

    // Inject Stylesheet
    const style = document.createElement('style');
    style.textContent = `
      #logmark-widget-container {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }
      #logmark-widget-bubble {
        width: 60px;
        height: 60px;
        border-radius: 30px;
        background: linear-gradient(135deg, #10b981, #059669);
        box-shadow: 0 8px 24px rgba(5, 150, 105, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        transform: scale(1);
      }
      #logmark-widget-bubble:hover {
        transform: scale(1.08) translateY(-2px);
        box-shadow: 0 12px 28px rgba(5, 150, 105, 0.45);
      }
      #logmark-widget-bubble:active {
        transform: scale(0.95);
      }
      #logmark-widget-bubble svg {
        width: 28px;
        height: 28px;
        color: #ffffff;
        transition: transform 0.3s ease;
      }
      #logmark-widget-bubble.open svg {
        transform: rotate(90deg);
      }
      #logmark-widget-frame-container {
        position: absolute;
        bottom: 76px;
        right: 0;
        width: 380px;
        height: 600px;
        max-height: calc(100vh - 120px);
        background: #ffffff;
        border-radius: 16px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.16);
        border: 1px solid rgba(0, 0, 0, 0.08);
        overflow: hidden;
        opacity: 0;
        transform: translateY(20px) scale(0.95);
        pointer-events: none;
        transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        transform-origin: bottom right;
      }
      #logmark-widget-frame-container.open {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: all;
      }
      #logmark-widget-iframe {
        width: 100%;
        height: 100%;
        border: none;
        background: #ffffff;
      }
      @media (max-width: 480px) {
        #logmark-widget-container {
          bottom: 12px;
          right: 12px;
        }
        #logmark-widget-frame-container {
          width: calc(100vw - 24px);
          height: calc(100vh - 100px);
          right: 0;
        }
      }
    `;
    document.head.appendChild(style);

    // Create Container
    const container = document.createElement('div');
    container.id = 'logmark-widget-container';

    // Build HTML structure
    container.innerHTML = `
      <div id="logmark-widget-frame-container">
        <iframe id="logmark-widget-iframe" src="about:blank" title="Logmark Assistant"></iframe>
      </div>
      <div id="logmark-widget-bubble" title="Chat with Assistant">
        <svg id="logmark-icon-svg" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      </div>
    `;
    document.body.appendChild(container);

    // Event Handlers
    const bubble = document.getElementById('logmark-widget-bubble');
    const frameContainer = document.getElementById('logmark-widget-frame-container');
    const iframe = document.getElementById('logmark-widget-iframe');
    let loaded = false;

    bubble.addEventListener('click', function() {
      const isOpen = frameContainer.classList.contains('open');
      if (isOpen) {
        frameContainer.classList.remove('open');
        bubble.classList.remove('open');
        bubble.innerHTML = `
          <svg id="logmark-icon-svg" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        `;
      } else {
        if (!loaded) {
          iframe.src = iframeSource;
          loaded = true;
        }
        frameContainer.classList.add('open');
        bubble.classList.add('open');
        bubble.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        `;
      }
    });
  }

  initWidget();
})();
