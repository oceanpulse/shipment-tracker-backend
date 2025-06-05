// services/shipmentSimulator.js
const { v4: uuidv4 } = require('uuid');

function getRandomInRange(min, max, decimals = 6) {
    return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

const statuses = ['IN_TRANSIT', 'AT_HUB', 'OUT_FOR_DELIVERY'];

let initialMockShipmentsData = [
    { tracking_number: 'TN123456789', origin: 'New York, NY', destination: 'Los Angeles, CA', current_latitude: 40.7128, current_longitude: -74.0060, status: 'IN_TRANSIT', estimated_delivery_date: '2024-12-15' },
    { tracking_number: 'TN987654321', origin: 'Chicago, IL', destination: 'Miami, FL', current_latitude: 41.8781, current_longitude: -87.6298, status: 'PENDING', estimated_delivery_date: '2024-12-12' },
];

let activeSimulatedShipments = [];

async function ensureInitialShipments(db) {
    console.log(`Ensuring initial shipments in database '${process.env.DB_NAME}'...`);
    for (const shipmentData of initialMockShipmentsData) {
        try {
            const [existing] = await db.query(
                `SELECT id, tracking_number FROM \`${process.env.DB_NAME}\`.\`shipments\` WHERE tracking_number = ?`,
                [shipmentData.tracking_number]
            );

            if (existing.length === 0) {
                const newId = uuidv4();
                await db.query(
                    `INSERT INTO \`${process.env.DB_NAME}\`.\`shipments\` (id, tracking_number, origin, destination, current_latitude, current_longitude, status, estimated_delivery_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [newId, shipmentData.tracking_number, shipmentData.origin, shipmentData.destination, parseFloat(shipmentData.current_latitude), parseFloat(shipmentData.current_longitude), shipmentData.status, shipmentData.estimated_delivery_date]
                );
                console.log(`Inserted initial shipment: ${shipmentData.tracking_number} with ID ${newId}`);
            } else {
                console.log(`Initial shipment ${shipmentData.tracking_number} already exists with ID ${existing[0].id}.`);
            }
        } catch (error) {
            console.error(`Error ensuring initial shipment ${shipmentData.tracking_number}:`, error);
        }
    }

    try {
        const [rows] = await db.query(`SELECT * FROM \`${process.env.DB_NAME}\`.\`shipments\``);
        // Ensure lat/lon are numbers when loaded
        activeSimulatedShipments = rows.map(shipment => ({
            ...shipment,
            current_latitude: parseFloat(shipment.current_latitude),
            current_longitude: parseFloat(shipment.current_longitude)
        }));
        console.log(`Loaded ${activeSimulatedShipments.length} shipments from DB for simulation.`);
    } catch (error) {
        console.error("Error loading shipments from DB for simulation:", error);
    }
}


module.exports = async (io, db) => {
    await ensureInitialShipments(db);

    if (activeSimulatedShipments.length === 0) {
        console.log("Shipment simulator: No active shipments to simulate.");
        return;
    }
    console.log("Shipment simulator started.");

    setInterval(async () => {
        if (activeSimulatedShipments.length === 0) return;

        const shipmentIndex = Math.floor(Math.random() * activeSimulatedShipments.length);
        const shipmentToUpdate = { ...activeSimulatedShipments[shipmentIndex] };

        if (shipmentToUpdate.status === 'DELIVERED' || shipmentToUpdate.status === 'EXCEPTION') {
            return;
        }

        // Ensure current_latitude and current_longitude are numbers before arithmetic
        let lat = parseFloat(shipmentToUpdate.current_latitude);
        let lon = parseFloat(shipmentToUpdate.current_longitude);

        if (isNaN(lat)) lat = 0; // Default if somehow NaN
        if (isNaN(lon)) lon = 0; // Default if somehow NaN

        // Simulate location change
        const latChange = getRandomInRange(-0.05, 0.05);
        const lonChange = getRandomInRange(-0.05, 0.05);

        shipmentToUpdate.current_latitude = parseFloat((lat + latChange).toFixed(8)); // Apply arithmetic and then toFixed for DB precision
        shipmentToUpdate.current_longitude = parseFloat((lon + lonChange).toFixed(8)); // Apply arithmetic and then toFixed for DB precision


        let statusChanged = false;
        if (Math.random() < 0.15) {
            statusChanged = true;
            if (shipmentToUpdate.status === 'PENDING') {
                shipmentToUpdate.status = 'IN_TRANSIT';
            } else if (shipmentToUpdate.status === 'IN_TRANSIT') {
                shipmentToUpdate.status = Math.random() < 0.7 ? 'AT_HUB' : 'DELAYED';
            } else if (shipmentToUpdate.status === 'AT_HUB') {
                shipmentToUpdate.status = 'OUT_FOR_DELIVERY';
            } else if (shipmentToUpdate.status === 'OUT_FOR_DELIVERY') {
                shipmentToUpdate.status = Math.random() < 0.8 ? 'DELIVERED' : 'EXCEPTION';
            } else if (shipmentToUpdate.status === 'DELAYED') {
                shipmentToUpdate.status = Math.random() < 0.5 ? 'IN_TRANSIT' : 'EXCEPTION';
            }
        }

        try {
            // The values being passed here should now be clean numbers
            await db.query(
                `UPDATE \`${process.env.DB_NAME}\`.\`shipments\` SET current_latitude = ?, current_longitude = ?, status = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`,
                [shipmentToUpdate.current_latitude, shipmentToUpdate.current_longitude, shipmentToUpdate.status, shipmentToUpdate.id]
            );

            console.log(`Updating shipment ${shipmentToUpdate.tracking_number} (ID: ${shipmentToUpdate.id}): lat=${shipmentToUpdate.current_latitude.toFixed(4)}, lon=${shipmentToUpdate.current_longitude.toFixed(4)}, status=${shipmentToUpdate.status}`);
            io.emit('shipmentUpdate', shipmentToUpdate);

            if (statusChanged && (shipmentToUpdate.status === 'DELAYED' || shipmentToUpdate.status === 'EXCEPTION')) {
                io.emit('shipmentAlert', { /* ... */ });
            }
            if (statusChanged && shipmentToUpdate.status === 'DELIVERED') {
                io.emit('shipmentAlert', { /* ... */ });
            }

            activeSimulatedShipments[shipmentIndex] = shipmentToUpdate;

        } catch (error) {
            console.error(`Error updating shipment ${shipmentToUpdate.id} in DB or emitting event:`, error);
            // Log the problematic values if the error persists
            if (error.code === 'WARN_DATA_TRUNCATED' || error.errno === 1265) {
                 console.error("Problematic lat/lon values for update:", shipmentToUpdate.current_latitude, shipmentToUpdate.current_longitude);
            }
        }

    }, 7000);
};