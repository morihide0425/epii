(() => {
  'use strict';
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const contentNode = document.getElementById('site-content');
  const siteContent = contentNode ? JSON.parse(contentNode.textContent) : {};
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if ('IntersectionObserver' in window) {
    document.documentElement.classList.add('js');
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 });
    $$('.reveal').forEach(el => observer.observe(el));
  }

  const menuToggle = $('.menu-toggle');
  const mobileNav = $('#mobile-nav');
  function setNav(open) {
    mobileNav.hidden = !open;
    menuToggle.setAttribute('aria-expanded', String(open));
    menuToggle.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');
    document.body.classList.toggle('nav-open', open);
  }
  menuToggle.addEventListener('click', () => setNav(mobileNav.hidden));
  $$('a', mobileNav).forEach(a => a.addEventListener('click', () => setNav(false)));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !mobileNav.hidden) { setNav(false); menuToggle.focus(); }
    if (e.key === 'Tab' && !mobileNav.hidden) {
      const items = [menuToggle, ...$$('a', mobileNav)];
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  matchMedia('(min-width: 761px)').addEventListener('change', event => { if (event.matches) setNav(false); });

  const tabs = $$('[role="tab"]');
  function selectTab(tab, moveFocus = false) {
    tabs.forEach(item => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      $('#' + item.getAttribute('aria-controls')).hidden = !selected;
    });
    if (moveFocus) tab.focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', e => {
      let index;
      if (e.key === 'ArrowRight') index = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') index = (i + tabs.length - 1) % tabs.length;
      if (e.key === 'Home') index = 0;
      if (e.key === 'End') index = tabs.length - 1;
      if (index !== undefined) { e.preventDefault(); selectTab(tabs[index], true); }
    });
  });
  $$('[data-select-tab]').forEach(link => link.addEventListener('click', () => selectTab($('#tab-' + link.dataset.selectTab))));

  const reservation = $('#reservation-dialog');
  $$('[data-reserve]').forEach(button => button.addEventListener('click', () => { setNav(false); reservation.showModal(); }));
  $$('dialog').forEach(dialog => {
    $('[data-close]', dialog).addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', e => {
      if (e.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close();
    });
  });

  const slides = $$('.hero-image');
  const captions = ['季節を映す、ひと皿。', 'ひと息に、わたしを想う。', '台灣の記憶と、季節の恵み。'];
  const pauseButton = $('#slide-pause');
  let currentSlide = 0;
  let playing = false;
  let slideTimer;
  function showSlide(index) {
    currentSlide = (index + slides.length) % slides.length;
    slides.forEach((img, i) => {
      img.classList.toggle('active', i === currentSlide);
      img.setAttribute('aria-hidden', String(i !== currentSlide));
    });
    $('#slide-current').textContent = String(currentSlide + 1).padStart(2, '0');
    $('#hero-caption').textContent = captions[currentSlide];
  }
  function scheduleSlides() {
    clearInterval(slideTimer);
    pauseButton.textContent = playing ? 'Ⅱ' : '▷';
    pauseButton.setAttribute('aria-pressed', String(playing));
    pauseButton.setAttribute('aria-label', playing ? '写真の自動切替を停止' : '写真の自動切替を再生');
    if (playing && !document.hidden) slideTimer = setInterval(() => showSlide(currentSlide + 1), 7000);
  }
  $('#slide-prev').addEventListener('click', () => { showSlide(currentSlide - 1); playing = false; scheduleSlides(); });
  $('#slide-next').addEventListener('click', () => { showSlide(currentSlide + 1); playing = false; scheduleSlides(); });
  pauseButton.addEventListener('click', () => { playing = !playing; scheduleSlides(); });
  document.addEventListener('visibilitychange', scheduleSlides);
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) playing = false; scheduleSlides(); });
  showSlide(0);

  const gallery = [
    {src:siteContent.journal1Photo || '/web/img/soup.webp',alt:siteContent.journal1Alt || '白い器に注がれた、橙色の季節のスープ',caption:'01 / ' + (siteContent.journal1Caption || '季節をすくう')},
    {src:siteContent.journal2Photo || '/web/img/dessert.webp',alt:siteContent.journal2Alt || '白い器に盛られた台湾の甘味',caption:'02 / ' + (siteContent.journal2Caption || '台灣に想いを')},
    {src:siteContent.journal3Photo || '/web/img/shop.webp',alt:siteContent.journal3Alt || '店頭に並ぶ養生茶',caption:'03 / ' + (siteContent.journal3Caption || '日々に、お茶を')}
  ];
  const galleryDialog = $('#gallery-dialog');
  let currentGallery = 0;
  function showGallery(index) {
    currentGallery = (index + gallery.length) % gallery.length;
    $('#gallery-image').src = gallery[currentGallery].src;
    $('#gallery-image').alt = gallery[currentGallery].alt;
    $('#gallery-caption').textContent = gallery[currentGallery].caption;
  }
  $$('[data-gallery]').forEach(button => button.addEventListener('click', () => { showGallery(Number(button.dataset.gallery)); galleryDialog.showModal(); }));
  $('#gallery-prev').addEventListener('click', () => showGallery(currentGallery - 1));
  $('#gallery-next').addEventListener('click', () => showGallery(currentGallery + 1));
  galleryDialog.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); showGallery(currentGallery - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); showGallery(currentGallery + 1); }
  });

  const parallaxImages = $$('[data-parallax]');
  let ticking = false;
  function updateParallax() {
    parallaxImages.forEach(img => {
      if (reducedMotion.matches) { img.style.transform = ''; return; }
      const rect = img.parentElement.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) return;
      const distance = (innerHeight / 2 - (rect.top + rect.height / 2)) * Number(img.dataset.parallax);
      const bounded = Math.max(-rect.height * .07, Math.min(rect.height * .07, distance));
      img.style.transform = `translate3d(0,${bounded}px,0)`;
    });
    ticking = false;
  }
  addEventListener('scroll', () => { if (!ticking) { requestAnimationFrame(updateParallax); ticking = true; } }, {passive:true});
  addEventListener('resize', updateParallax);
  reducedMotion.addEventListener('change', updateParallax);
  updateParallax();
})();
