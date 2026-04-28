const fs = require('fs');
const { parse } = require('csv-parse');
const { db } = require('../db');

class SoftwareImport {
    /**
     * Parse column-based CSV file into lab/software pairs
     * @param {string} filePath - Path to uploaded CSV file
     * @returns {Promise<Array>} Array of { lab, software } objects
     */
    static parseCSV(filePath) {
        return new Promise((resolve, reject) => {
            const results = [];
            const labSoftwareMap = new Map();

            fs.createReadStream(filePath)
                .pipe(parse({
                    columns: true,
                    skip_empty_lines: true,
                    trim: true
                }))
                .on('data', (row) => {
                    // Process each row - for each column (lab)
                    Object.keys(row).forEach(labName => {
                        const softwareName = row[labName]?.trim();
                        
                        // Skip empty values
                        if (!softwareName || softwareName.length === 0) return;

                        // Normalize names
                        const normalizedLab = labName.trim();
                        const normalizedSoftware = softwareName.trim();

                        // Skip duplicates within same lab
                        if (!labSoftwareMap.has(normalizedLab)) {
                            labSoftwareMap.set(normalizedLab, new Set());
                        }
                        
                        const softwareSet = labSoftwareMap.get(normalizedLab);
                        if (!softwareSet.has(normalizedSoftware.toLowerCase())) {
                            softwareSet.add(normalizedSoftware.toLowerCase());
                            results.push({
                                lab: normalizedLab,
                                software: normalizedSoftware
                            });
                        }
                    });
                })
                .on('end', () => resolve(results))
                .on('error', (err) => reject(err));
        });
    }

    /**
     * Group parsed data by laboratory
     * @param {Array} parsedData 
     * @returns {Object} Lab -> Software list mapping
     */
    static groupByLab(parsedData) {
        const grouped = {};
        
        parsedData.forEach(item => {
            if (!grouped[item.lab]) {
                grouped[item.lab] = [];
            }
            grouped[item.lab].push(item.software);
        });

        // Sort software lists
        Object.keys(grouped).forEach(lab => {
            grouped[lab].sort((a, b) => a.localeCompare(b));
        });

        return grouped;
    }

    /**
     * Perform full import replacing all existing data
     * @param {Array} parsedData 
     * @param {number} adminId 
     * @param {string} filename 
     * @returns {Promise<Object>} Import summary
     */
    static performImport(parsedData, adminId, filename) {
        return new Promise((resolve, reject) => {
            const grouped = this.groupByLab(parsedData);
            const labNames = Object.keys(grouped);
            const totalSoftware = parsedData.length;

            db.serialize(() => {
                db.run('BEGIN TRANSACTION');

                try {
                    // 1. Clear existing relationships
                    db.run('DELETE FROM lab_software');

                    // 2. Insert all laboratories
                    const labStmt = db.prepare('INSERT OR IGNORE INTO laboratories (name) VALUES (?)');
                    labNames.forEach(lab => labStmt.run(lab));
                    labStmt.finalize();

                    // 3. Insert all software
                    const softwareStmt = db.prepare('INSERT OR IGNORE INTO software (name) VALUES (?)');
                    const uniqueSoftware = [...new Set(parsedData.map(i => i.software))];
                    uniqueSoftware.forEach(sw => softwareStmt.run(sw));
                    softwareStmt.finalize();

                    // 4. Build relationships
                    const relationStmt = db.prepare(`
                        INSERT OR IGNORE INTO lab_software (lab_id, software_id)
                        VALUES (
                            (SELECT id FROM laboratories WHERE name = ?),
                            (SELECT id FROM software WHERE name = ?)
                        )
                    `);

                    parsedData.forEach(item => {
                        relationStmt.run(item.lab, item.software);
                    });
                    relationStmt.finalize();

                    // 5. Log import history
                    db.run(`
                        INSERT INTO software_import_logs 
                        (filename, total_labs, total_software, imported_by)
                        VALUES (?, ?, ?, ?)
                    `, [filename, labNames.length, totalSoftware, adminId]);

                    db.run('COMMIT', (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            return reject(err);
                        }
                        
                        resolve({
                            success: true,
                            labs: labNames.length,
                            software: totalSoftware,
                            uniqueSoftware: uniqueSoftware.length
                        });
                    });

                } catch (err) {
                    db.run('ROLLBACK');
                    reject(err);
                }
            });
        });
    }

    /**
     * Get import history
     * @param {number} limit 
     * @returns {Promise<Array>}
     */
    static getImportHistory(limit = 50) {
        return new Promise((resolve, reject) => {
            db.all(`
                SELECT l.*, u.first_name, u.last_name 
                FROM software_import_logs l
                LEFT JOIN users u ON l.imported_by = u.id
                ORDER BY l.created_at DESC
                LIMIT ?
            `, [limit], (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });
    }

    /**
     * Clean up temporary uploaded file
     * @param {string} filePath 
     */
    static cleanupTempFile(filePath) {
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) console.warn('Failed to cleanup temp file:', err);
            });
        }
    }
}

module.exports = SoftwareImport;