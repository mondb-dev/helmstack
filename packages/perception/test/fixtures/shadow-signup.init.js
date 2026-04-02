const host = document.getElementById("shadow-host");
const root = host.attachShadow({ mode: "open" });
root.innerHTML = `
  <section>
    <h1>Create account</h1>
    <form id="shadow-signup-form" name="shadow-signup">
      <label>Email<input id="shadow-email" type="email" name="email" required autocomplete="email" /></label>
      <label>Password<input id="shadow-password" type="password" name="password" required /></label>
      <button type="submit">Create Account</button>
    </form>
  </section>
`;
