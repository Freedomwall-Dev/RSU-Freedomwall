/**
 * pwa.js — PWA install button handler
 * Include this script on every page that has #installNavItem / #installBtn in the nav.
 * Works on index.html, about.html, contact.html, etc.
 */
(function () {
    const INSTALL_AVAILABLE_KEY = 'pwaInstallAvailable';
    let deferredInstallPrompt = null;

    function showInstallBtn() {
        var item = document.getElementById('installNavItem');
        if (item) item.style.display = 'block';
    }

    function hideInstallBtn() {
        var item = document.getElementById('installNavItem');
        if (item) item.style.display = 'none';
    }

    function initInstallButton() {
        var installBtn = document.getElementById('installBtn');
        if (!installBtn) return;

        // If a previous page load captured the prompt, show the button immediately
        if (sessionStorage.getItem(INSTALL_AVAILABLE_KEY) === '1') {
            showInstallBtn();
        }

        window.addEventListener('beforeinstallprompt', function (e) {
            e.preventDefault();
            deferredInstallPrompt = e;
            sessionStorage.setItem(INSTALL_AVAILABLE_KEY, '1');
            showInstallBtn();
        });

        installBtn.addEventListener('click', async function () {
            if (!deferredInstallPrompt) return;
            deferredInstallPrompt.prompt();
            var result = await deferredInstallPrompt.userChoice;
            console.log('Install prompt outcome:', result.outcome);
            deferredInstallPrompt = null;
            sessionStorage.removeItem(INSTALL_AVAILABLE_KEY);
            hideInstallBtn();
        });

        window.addEventListener('appinstalled', function () {
            deferredInstallPrompt = null;
            sessionStorage.removeItem(INSTALL_AVAILABLE_KEY);
            hideInstallBtn();
            console.log('PWA was installed');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initInstallButton);
    } else {
        initInstallButton();
    }
})();