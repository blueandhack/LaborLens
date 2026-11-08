import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { applyPageSEO, getPageSEO } from '../utils/seo.js';

export default function PageSEO() {
  const { pathname, search } = useLocation();
  useEffect(() => { applyPageSEO(getPageSEO(pathname, search)); }, [pathname, search]);
  return null;
}
