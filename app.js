const express = require("express");
const mysql = require("mysql2");
const session = require("express-session");
const bodyParser = require("body-parser");
const PDFDocument = require("pdfkit");
const path = require("path");

const app = express();

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(
  session({
    secret: "gamestore_secret_key_secure",
    resave: false,
    saveUninitialized: true,
  })
);

app.use((req, res, next) => {
  if (!req.session.cart) req.session.cart = [];
  res.locals.user = req.session.user || null;
  res.locals.cartCount = req.session.cart.reduce(
    (sum, item) => sum + item.cantidad,
    0
  );
  res.locals.showToast = req.query.added === "true";
  next();
});

const db = mysql.createConnection({
  host: process.env.MYSQLHOST || "localhost",
  user: process.env.MYSQLUSER || "root",
  password: process.env.MYSQLPASSWORD || "",
  database: process.env.MYSQLDATABASE || "db_gamestore",
  port: process.env.MYSQLPORT || 3306,
});

db.connect((err) => {
  if (err) console.error("Error DB:", err);
  else console.log("Conectado a MySQL");
});

app.get("/", (req, res) => {
  let sql = "SELECT * FROM productos WHERE 1=1";
  let params = [];

  if (req.query.search) {
    sql += " AND nombre LIKE ?";
    params.push("%" + req.query.search + "%");
  }
  if (req.query.cat) {
    sql += " AND categoria = ?";
    params.push(req.query.cat);
  }

  db.query(sql, params, (err, productos) => {
    db.query("SELECT DISTINCT categoria FROM productos", (err2, categorias) => {
      res.render("index", {
        productos,
        categorias,
        activeCat: req.query.cat || "",
        activeSearch: req.query.search || "",
      });
    });
  });
});

app.get("/login", (req, res) => res.render("login", { error: null }));
app.get("/register", (req, res) => res.render("register", { error: null }));
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

app.post("/register", (req, res) => {
  const { nombre, email, password } = req.body;
  db.query(
    "INSERT INTO usuarios (nombre, email, password) VALUES (?, ?, ?)",
    [nombre, email, password],
    (err) => {
      if (err) return res.render("register", { error: "Correo ya registrado" });
      res.redirect("/login");
    }
  );
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  db.query(
    "SELECT * FROM usuarios WHERE email = ? AND password = ?",
    [email, password],
    (err, users) => {
      if (users.length > 0) {
        req.session.user = users[0];
        res.redirect("/");
      } else {
        res.render("login", { error: "Credenciales incorrectas" });
      }
    }
  );
});

app.get("/cart", (req, res) => {
  let total = 0;
  req.session.cart.forEach((p) => (total += p.precio * p.cantidad));
  res.render("cart", { cart: req.session.cart, total });
});

app.post("/cart/add", (req, res) => {
  const { id, nombre, precio, imagen, cantidad } = req.body;

  const qty = parseInt(cantidad, 10);
  const finalQty = isNaN(qty) || qty < 1 ? 1 : qty;

  const item = req.session.cart.find((p) => p.id == id);
  if (item) {
    item.cantidad += finalQty;
  } else {
    req.session.cart.push({
      id,
      nombre,
      precio: parseFloat(precio),
      imagen,
      cantidad: finalQty,
    });
  }
  res.redirect("/?added=true");
});

app.get("/cart/remove/:id", (req, res) => {
  req.session.cart = req.session.cart.filter((p) => p.id != req.params.id);
  res.redirect("/cart");
});

app.post("/cart/update", (req, res) => {
  const { id, accion } = req.body;
  const item = req.session.cart.find((p) => p.id == id);
  if (item) {
    if (accion === "sumar") item.cantidad++;
    if (accion === "restar" && item.cantidad > 1) item.cantidad--;
  }
  let total = 0;
  req.session.cart.forEach((p) => (total += p.precio * p.cantidad));
  res.json({ success: true, newQty: item ? item.cantidad : 0, total });
});

app.post("/checkout", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.cart.length === 0) return res.redirect("/");

  let total = 0;
  req.session.cart.forEach((p) => (total += p.precio * p.cantidad));

  db.query(
    "INSERT INTO ventas (usuario_id, total) VALUES (?, ?)",
    [req.session.user.id, total],
    (err, result) => {
      const ventaId = result.insertId;
      const detalles = req.session.cart.map((p) => [
        ventaId,
        p.id,
        p.cantidad,
        p.precio,
      ]);
      db.query(
        "INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario) VALUES ?",
        [detalles],
        () => {
          req.session.cart = [];
          res.render("success", { ventaId });
        }
      );
    }
  );
});

app.get("/ticket/:id", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const sql = `SELECT v.id, v.fecha, v.total, u.nombre, p.nombre as prod, dv.cantidad, dv.precio_unitario 
                 FROM ventas v JOIN usuarios u ON v.usuario_id = u.id JOIN detalle_ventas dv ON v.id = dv.venta_id 
                 JOIN productos p ON dv.producto_id = p.id WHERE v.id = ?`;
  db.query(sql, [req.params.id], (err, rows) => {
    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    doc.pipe(res);
    doc.fontSize(22).text("GAMESTORE DIGITAL", { align: "center" });
    doc
      .fontSize(10)
      .text(
        `Orden #${rows[0].id} | ${new Date(rows[0].fecha).toLocaleString()}`,
        { align: "center" }
      );
    doc.moveDown();
    rows.forEach((r) =>
      doc
        .fontSize(12)
        .text(
          `${r.cantidad} x ${r.prod}  -  $${r.precio_unitario * r.cantidad}`
        )
    );
    doc.moveDown();
    doc
      .fontSize(16)
      .text(`TOTAL PAGADO: $${rows[0].total}`, { align: "right" });
    doc.end();
  });
});

app.get("/history", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  db.query(
    "SELECT * FROM ventas WHERE usuario_id = ? ORDER BY fecha DESC",
    [req.session.user.id],
    (err, ventas) => {
      res.render("history", { ventas });
    }
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
