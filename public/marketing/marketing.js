// Shared across every marketing page. Kept dependency-free (no build step) since this is a
// small set of static pages, not the hospital application.

const NAV_LINKS = [
  ['/marketing/features.html', 'Features'],
  ['/marketing/solutions.html', 'Solutions'],
  ['/marketing/pricing.html', 'Pricing'],
  ['/marketing/security.html', 'Security'],
  ['/marketing/about.html', 'About']
];

function renderHeader() {
  const header = document.getElementById('site-header');
  if (!header) return;
  header.innerHTML = `
    <div class="wrap">
      <a href="/marketing/index.html" class="logo"><span class="mark"></span>Aiventra</a>
      <nav class="main-nav">
        ${NAV_LINKS.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}
      </nav>
      <div class="header-cta">
        <a href="/#/login" class="btn btn-outline" style="padding:10px 20px">Log In</a>
        <a href="/marketing/signup.html" class="btn btn-primary" style="padding:10px 20px">Start Free Demo</a>
      </div>
    </div>`;
}

function renderFooter() {
  const footer = document.getElementById('site-footer');
  if (!footer) return;
  footer.innerHTML = `
    <div class="wrap">
      <div class="footer-grid">
        <div>
          <a href="/marketing/index.html" class="logo" style="margin-bottom:14px"><span class="mark"></span>Aiventra</a>
          <p style="max-width:280px">Intelligent Solutions. Transforming Futures.<br>One platform for hospital registration, OPD, IPD, billing, pharmacy and laboratory operations.</p>
        </div>
        <div>
          <h4>Product</h4>
          <a href="/marketing/features.html">Features</a>
          <a href="/marketing/solutions.html">Solutions</a>
          <a href="/marketing/pricing.html">Pricing</a>
          <a href="/marketing/security.html">Security</a>
        </div>
        <div>
          <h4>Company</h4>
          <a href="/marketing/about.html">About</a>
          <a href="/marketing/contact.html">Contact</a>
          <a href="/marketing/book-demo.html">Book a Demo</a>
          <a href="/marketing/faq.html">FAQ</a>
        </div>
        <div>
          <h4>Get in touch</h4>
          <p>helloaiventra@gmail.com</p>
          <p>6352781789</p>
          <p>Ahmedabad, Gujarat, India</p>
        </div>
      </div>
      <div class="footer-bottom">
        <span>&copy; ${new Date().getFullYear()} Aiventra. All rights reserved.</span>
        <span><a href="/marketing/privacy-policy.html">Privacy Policy</a> &nbsp;&middot;&nbsp; <a href="/marketing/terms-of-service.html">Terms of Service</a></span>
      </div>
    </div>`;
}

// ---------- scroll reveal (single orchestrated fade-up on entry, respects reduced motion) ----------
function initScrollReveal() {
  const items = document.querySelectorAll('.reveal');
  if (!items.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    items.forEach(el => el.classList.add('in-view'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('in-view'); io.unobserve(entry.target); } });
  }, { threshold: 0.15 });
  items.forEach(el => io.observe(el));
}

// ---------- animated counters ----------
function initCounters() {
  const counters = document.querySelectorAll('[data-counter]');
  if (!counters.length) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = (el) => {
    const target = parseFloat(el.dataset.counter);
    const suffix = el.dataset.suffix || '';
    if (reduce) { el.textContent = target.toLocaleString('en-IN') + suffix; return; }
    const duration = 1200;
    const start = performance.now();
    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(target * eased).toLocaleString('en-IN') + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  };
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => { if (entry.isIntersecting) { animate(entry.target); io.unobserve(entry.target); } });
  }, { threshold: 0.5 });
  counters.forEach(el => io.observe(el));
}

// ---------- FAQ accordion ----------
function initFaqAccordion() {
  document.querySelectorAll('.faq-item').forEach(item => {
    item.querySelector('.faq-q').addEventListener('click', () => {
      const wasOpen = item.classList.contains('open');
      item.parentElement.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });
}

// ---------- mobile nav ----------
function initMobileNav() {
  const toggle = document.querySelector('.nav-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const nav = document.querySelector('.main-nav');
    nav.style.display = nav.style.display === 'flex' ? 'none' : 'flex';
    nav.style.cssText += 'position:absolute;top:76px;left:0;right:0;background:#FAF9F6;flex-direction:column;padding:20px 28px;border-bottom:1px solid #E6E8EF;';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderHeader();
  renderFooter();
  initScrollReveal();
  initCounters();
  initFaqAccordion();
  initMobileNav();
});
