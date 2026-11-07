export async function getJSON(url, { signal } = {}) {
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.error || "Unable to load this page"), {
      status: response.status,
    });
  }
  return data;
}
