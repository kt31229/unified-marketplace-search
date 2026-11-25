import { useEffect, useState } from 'react';

export function BackToTopTab() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const update = () => setVisible(window.scrollY > window.innerHeight);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  const handleClick = () => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  if (!visible) {
    return null;
  }

  return (
    <button type="button" className="back-to-top-tab" onClick={handleClick}>
      <span aria-hidden="true">↑</span>
      <span>Back to top</span>
    </button>
  );
}
