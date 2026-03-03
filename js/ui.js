// ui.js - Handles sidebar and theme functionality
document.addEventListener('DOMContentLoaded', function() {
    // Theme functionality
    function initTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        updateThemeButton(savedTheme);
    }

    function toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        updateThemeButton(newTheme);
    }

    function updateThemeButton(theme) {
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.innerHTML = theme === 'dark' 
                ? '<i class="fas fa-sun"></i> Light Mode' 
                : '<i class="fas fa-moon"></i> Dark Mode';
        }
    }

    // Sidebar functionality
    function setupSidebar() {
        const menuToggle = document.getElementById('menuToggle');
        const closeSidebar = document.getElementById('closeSidebar');
        const sidebar = document.querySelector('.sidebar');
        const mainContent = document.querySelector('.main-content');

        if (menuToggle && sidebar) {
            menuToggle.addEventListener('click', function() {
                sidebar.classList.toggle('open');
            });
        }

        if (closeSidebar && sidebar) {
            closeSidebar.addEventListener('click', function() {
                sidebar.classList.remove('open');
            });
        }

        if (mainContent && sidebar) {
            mainContent.addEventListener('click', function() {
                if (window.innerWidth < 768 && sidebar.classList.contains('open')) {
                    sidebar.classList.remove('open');
                }
            });
        }
    }

    // Initialize everything
    initTheme();
    setupSidebar();

    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }
});