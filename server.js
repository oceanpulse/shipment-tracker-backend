
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const db = require('./config/db'); // Your database pool module
const { v4: uuidv4 } = require('uuid'); // For generating IDs if needed

const app = express();
app.use(cors()); // Allow requests from Vue frontend
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "http://localhost:5173", //dev server
        methods: ["GET", "POST"]
    }
});

// --- Database Initialization 
async function initializeDatabase() {
    let connection;
    try {
        connection = await db.getConnection();
        console.log(`Attempting to create and use database: ${process.env.DB_NAME}`);
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``);
        await connection.query(`USE \`${process.env.DB_NAME}\``); // This sets the DB for this specific connection for table creation

        console.log(`Creating table 'shipments' in database '${process.env.DB_NAME}' if it doesn't exist.`);
        await connection.query(`
            CREATE TABLE IF NOT EXISTS shipments (
                id VARCHAR(36) PRIMARY KEY,
                tracking_number VARCHAR(255) UNIQUE NOT NULL,
                origin VARCHAR(255),
                destination VARCHAR(255),
                current_latitude DECIMAL(10, 8),
                current_longitude DECIMAL(11, 8),
                status ENUM('PENDING', 'IN_TRANSIT', 'DELAYED', 'AT_HUB', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION') DEFAULT 'PENDING',
                estimated_delivery_date DATE,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Add more tables like shipment_events, users if needed, e.g.:
        // await connection.query(`
        //     CREATE TABLE IF NOT EXISTS shipment_events (
        //         event_id VARCHAR(36) PRIMARY KEY,
        //         shipment_id VARCHAR(36),
        //         event_type VARCHAR(255),
        //         description TEXT,
        //         location VARCHAR(255),
        //         event_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        //         FOREIGN KEY (shipment_id) REFERENCES shipments(id)
        //     )
        // `);
        console.log(`Database '${process.env.DB_NAME}' initialized and table 'shipments' created/ensured.`);
    } catch (error) {
        console.error(`Error initializing database '${process.env.DB_NAME}':`, error);
        if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error("Access denied. Check your DB_USER and DB_PASSWORD, and ensure the user has CREATE DATABASE privileges if the DB doesn't exist, or privileges on the specific database if it does.");
        }
        process.exit(1); // Exit if DB init fails
    } finally {
        if (connection) connection.release();
    }
}

// --- REST API Endpoints ---
app.get('/api/shipments', async (req, res) => {
    try {
        const query = `SELECT * FROM \`${process.env.DB_NAME}\`.\`shipments\` ORDER BY created_at DESC`;
        const [rows] = await db.query(query);
        res.json(rows);
    } catch (error) {
        console.error("Error fetching shipments:", error);
        res.status(500).json({ message: 'Error fetching shipments' });
    }
});

app.get('/api/shipments/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `SELECT * FROM \`${process.env.DB_NAME}\`.\`shipments\` WHERE id = ?`;
        const [rows] = await db.query(query, [id]);
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.status(404).json({ message: 'Shipment not found' });
        }
    } catch (error) {
        console.error(`Error fetching shipment ${id}:`, error);
        res.status(500).json({ message: 'Error fetching shipment details' });
    }
});

app.post('/api/shipments', async (req, res) => {
    // Ensure id is generated if not provided, or use provided one
    const id = req.body.id || uuidv4();
    const { tracking_number, origin, destination, current_latitude, current_longitude, status, estimated_delivery_date } = req.body;

    if (!tracking_number) { // ID is now auto-generated if missing
        return res.status(400).json({ message: "Tracking number is required" });
    }
    try {
        const query = `INSERT INTO \`${process.env.DB_NAME}\`.\`shipments\` (id, tracking_number, origin, destination, current_latitude, current_longitude, status, estimated_delivery_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        await db.query(
            query,
            [id, tracking_number, origin, destination, current_latitude, current_longitude, status, estimated_delivery_date]
        );

        const [newShipmentQueryResult] = await db.query(`SELECT * FROM \`${process.env.DB_NAME}\`.\`shipments\` WHERE id = ?`, [id]);
        const newShipment = newShipmentQueryResult[0];

        io.emit('shipmentCreated', newShipment); // Notify all clients
        res.status(201).json(newShipment);
    } catch (error) {
        console.error("Error creating shipment:", error);
        if (error.code === 'ER_DUP_ENTRY') {
            res.status(409).json({ message: 'Shipment with this ID or tracking number already exists.' });
        } else {
            res.status(500).json({ message: 'Error creating shipment' });
        }
    }
});


// --- WebSocket Logic ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });

    // Example: Client requests to join a room for a specific shipment
    socket.on('joinShipmentRoom', (shipmentId) => {
        socket.join(shipmentId); // Use shipmentId directly as room name
        console.log(`Socket ${socket.id} joined room for shipment ${shipmentId}`);
        // You could emit current shipment status to just this client
        // db.query(`SELECT * FROM \`${process.env.DB_NAME}\`.\`shipments\` WHERE id = ?`, [shipmentId])
        //   .then(([rows]) => {
        //     if (rows.length > 0) socket.emit('shipmentDetails', rows[0]);
        //   });
    });

    socket.on('leaveShipmentRoom', (shipmentId) => {
        socket.leave(shipmentId);
        console.log(`Socket ${socket.id} left room for shipment ${shipmentId}`);
    });
});

// --- Global variable for socket.io instance ---
// This allows other modules to emit events if needed, though direct passing is often cleaner
app.set('socketio', io);


// --- Initialize DB and Start Server ---
const PORT = process.env.PORT || 3001;

initializeDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Frontend expected at http://localhost:5173 (if using default Vite port)`);
        // Start the shipment simulator after server starts
        // Pass db and io directly to the simulator module
        require('./services/shipmentSimulator')(io, db);
    });
}).catch(initError => {
    console.error("Failed to initialize and start server:", initError);
    process.exit(1);
});