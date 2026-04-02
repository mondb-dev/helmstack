const host = document.getElementById("auth-frame-host");
const frame = document.createElement("iframe");
frame.id = "auth-frame";
host.append(frame);

const doc = document.implementation.createHTMLDocument("Embedded Frame");
doc.body.innerHTML = `
  <section>
    <h1>Log in</h1>
    <form id="frame-login-form" name="frame-login">
      <label>Email<input id="frame-email" type="email" name="email" /></label>
      <label>Password<input id="frame-password" type="password" name="password" /></label>
      <button type="submit">Sign in</button>
    </form>
  </section>
`;

Object.defineProperty(frame, "contentDocument", {
  configurable: true,
  value: doc
});
