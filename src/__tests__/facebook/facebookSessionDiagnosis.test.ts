import { diagnoseHomepage } from '../../services/facebook/facebookSessionDiagnosis';

describe('diagnoseHomepage', () => {
  it('reports checkpoint from the final URL path', () => {
    expect(diagnoseHomepage('<html></html>', 'https://www.facebook.com/checkpoint/1501092823525282/?next=https%3A%2F%2Fwww.facebook.com%2F')).toBe('checkpoint');
  });
  it('reports checkpoint from a meta refresh target', () => {
    const html = '<html><head><meta http-equiv="refresh" content="0;url=/checkpoint/1501092823525282/?next=x"></head></html>';
    expect(diagnoseHomepage(html, 'https://www.facebook.com/')).toBe('checkpoint');
  });
  it('reports checkpoint from a window.location redirect', () => {
    const html = '<script>window.location.href = "/checkpoint/123/";</script>';
    expect(diagnoseHomepage(html, null)).toBe('checkpoint');
  });
  it('reports logged_out from a /login final URL', () => {
    expect(diagnoseHomepage('<html></html>', 'https://www.facebook.com/login/?next=x')).toBe('logged_out');
  });
  it('reports logged_out for viewer id zero, ignoring the bare word checkpoint', () => {
    const html = '<script>var a="checkpoint";</script><script>{"actorID":"0"}</script>';
    expect(diagnoseHomepage(html, 'https://www.facebook.com/')).toBe('logged_out');
  });
  it('reports logged_out for USER_ID zero', () => {
    expect(diagnoseHomepage('{"USER_ID":"0"}')).toBe('logged_out');
  });
  it('reports unrecognised_page when no session marker is present', () => {
    expect(diagnoseHomepage('{"actorID":"100000000000001"}', 'https://www.facebook.com/')).toBe('unrecognised_page');
  });
  it('reports unrecognised_page for an empty page', () => {
    expect(diagnoseHomepage('')).toBe('unrecognised_page');
  });
  it('prefers checkpoint over logged_out', () => {
    expect(diagnoseHomepage('{"actorID":"0"}', 'https://m.facebook.com/checkpoint/1/')).toBe('checkpoint');
  });
});
