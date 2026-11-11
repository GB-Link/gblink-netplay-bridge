function join(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

export default { join, dirname };
