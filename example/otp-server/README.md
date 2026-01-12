# OTP Server Configuration for Metro Transit (Minneapolis-St. Paul)

This directory contains example OpenTripPlanner server configuration files for deploying with Metro Transit's GTFS and GTFS-RT feeds.

## Configuration Files

### `build-config.json`
Defines data sources for building the OTP graph:
- **GTFS feed**: `gtfs.zip` - Metro Transit static schedule data
- **OSM data**: `minneapolis-saint-paul_minnesota.osm.pbf` - Street network
- **Transfer requests**: Walk and bicycle transfer generation

### `router-config.json`
Defines routing behavior and real-time data updaters:
- **Routing defaults**: Bicycle speed, transfer settings, timeout configuration
- **GTFS-RT updaters**: Trip updates, vehicle positions, and service alerts

## Setup Instructions

### 1. Download Data Files

```bash
# Create OTP data directory
mkdir -p ~/otp
cd ~/otp

# Download current GTFS schedule
curl -o gtfs.zip "https://svc.metrotransit.org/mtgtfs/gtfs.zip"

# Download OSM data for Minneapolis-St. Paul
curl -o minneapolis-saint-paul_minnesota.osm.pbf \
  "https://download.geofabrik.de/north-america/us/minnesota-latest.osm.pbf"
```

### 2. Copy Configuration Files

```bash
# Copy configs from this example directory
cp example/otp-server/*.json ~/otp/
```

### 3. Build the Graph

```bash
# Navigate to your OTP installation
cd /path/to/opentripplanner

# Build graph (takes 5-10 minutes)
java -Xmx4G -jar otp-shaded-*.jar --build --save ~/otp
```

### 4. Start OTP Server

```bash
# Start server
java -Xmx2G -jar otp-shaded-*.jar --load ~/otp --port 8090
```

Check logs for real-time updater success:
```
INFO (ResultLogger) [feedId=1, type=gtfs-rt-trip-updates]
     XXX of XXX update messages were applied successfully (success rate: 100.0%)
```

## Real-Time Data Sources

Metro Transit provides GTFS-Realtime feeds that update every 10 seconds:

- **Trip Updates**: `https://svc.metrotransit.org/mtgtfs/tripupdates.pb`
  - Real-time arrival/departure predictions
  - Trip cancellations and additions
- **Vehicle Positions**: `https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb`
  - Live vehicle locations
  - Occupancy status
- **Service Alerts**: `https://svc.metrotransit.org/mtgtfs/alerts.pb`
  - Disruption notices
  - Detours and service changes

## Important Notes

### Feed ID Configuration

The `feedId` in `router-config.json` must match OTP's internal feed indexing:
- If GTFS `feed_info.txt` has no `feed_id`, OTP auto-assigns `"1"`
- Check your OTP build logs or query the API to verify the feed ID
- Update `feedId: "1"` in all three updaters if needed

### GTFS Updates

Metro Transit updates their GTFS schedule **weekly on Saturdays**. To update:

```bash
cd ~/otp
# Backup old files
mv gtfs.zip gtfs.zip.backup
mv graph.obj graph.obj.backup

# Download new GTFS
curl -o gtfs.zip "https://svc.metrotransit.org/mtgtfs/gtfs.zip"

# Rebuild graph
java -Xmx4G -jar /path/to/otp-shaded-*.jar --build --save ~/otp

# Restart server
pkill -f "otp-shaded.*8090"
java -Xmx2G -jar /path/to/otp-shaded-*.jar --load ~/otp --port 8090
```

### Troubleshooting

**Real-time updates failing (0% success rate)?**
- Check `feedId` matches between config and OTP's internal indexing
- Verify GTFS schedule is current (not expired)
- Check network access to Metro Transit's GTFS-RT endpoints

**Trips not found in graph?**
- Ensure GTFS data is current and covers today's date
- Check `calendar.txt` and `calendar_dates.txt` for service on current date
- Verify trip IDs in real-time feed match static GTFS

**High memory usage?**
- Increase `-Xmx` value (e.g., `-Xmx4G` for 4GB)
- Consider reducing transfer generation (`maxStopCount`)
- Disable unnecessary updaters

## Additional Resources

- [Metro Transit Developer Portal](https://svc.metrotransit.org/)
- [OpenTripPlanner Documentation](https://docs.opentripplanner.org/)
- [GTFS-RT Specification](https://gtfs.org/realtime/)
