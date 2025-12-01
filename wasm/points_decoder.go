//go:build js && wasm
// +build js,wasm

package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math"
	"syscall/js"
)

// Point represents a decoded point with x, y coordinates and pressure
type Point struct {
	X        float32 `json:"x"`
	Y        float32 `json:"y"`
	Pressure float32 `json:"pressure"`
	Flags    uint32  `json:"flags"`
}

// DecodeResult holds the decoded points
type DecodeResult struct {
	Points []Point `json:"points"`
	Count  int     `json:"count"`
}

// decodePoints decodes the Base64-encoded points data from Flexcil
// Format analysis:
// - First 4 bytes: number of points (uint32 little-endian, but stored as single byte in practice)
// - Following bytes: point data in groups
// - Each point seems to be: 12 bytes (3x float32: x_offset, y_offset, pressure/flags)
func decodePoints(base64Data string) (DecodeResult, error) {
	// Decode Base64
	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return DecodeResult{}, err
	}

	if len(data) < 4 {
		return DecodeResult{}, nil
	}

	// First byte is the point count (observed in samples)
	pointCount := int(data[0])

	// Each point entry is 12 bytes (3x 4 bytes)
	// Format appears to be: 4 bytes padding/zeros, then 12 bytes per point
	// After the count byte, we have 3 zero bytes, then point data

	points := make([]Point, 0, pointCount)

	// Point data starts at offset 4
	offset := 4
	bytesPerPoint := 12 // 3 float32s

	for i := 0; i < pointCount && offset+bytesPerPoint <= len(data); i++ {
		// Read 3 float32 values
		// x offset (relative to start.x in the JSON)
		xBits := binary.LittleEndian.Uint32(data[offset : offset+4])
		yBits := binary.LittleEndian.Uint32(data[offset+4 : offset+8])
		flagsBits := binary.LittleEndian.Uint32(data[offset+8 : offset+12])

		x := math.Float32frombits(xBits)
		y := math.Float32frombits(yBits)

		// The third value contains flags and possibly pressure
		// Extract pressure from the flags (appears to be encoded in upper bits)
		pressure := float32(1.0)
		flags := flagsBits

		// Check if this is a valid point (sometimes there's NaN or special values)
		if !math.IsNaN(float64(x)) && !math.IsNaN(float64(y)) {
			points = append(points, Point{
				X:        x,
				Y:        y,
				Pressure: pressure,
				Flags:    flags,
			})
		}

		offset += bytesPerPoint
	}

	return DecodeResult{
		Points: points,
		Count:  len(points),
	}, nil
}

// decodePointsJS is the JavaScript-callable wrapper
func decodePointsJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return js.ValueOf(map[string]interface{}{
			"error": "Missing base64 data argument",
		})
	}

	base64Data := args[0].String()
	result, err := decodePoints(base64Data)

	if err != nil {
		return js.ValueOf(map[string]interface{}{
			"error": err.Error(),
		})
	}

	// Convert points to JavaScript array
	pointsArray := make([]interface{}, len(result.Points))
	for i, p := range result.Points {
		pointsArray[i] = map[string]interface{}{
			"x":        p.X,
			"y":        p.Y,
			"pressure": p.Pressure,
			"flags":    p.Flags,
		}
	}

	return js.ValueOf(map[string]interface{}{
		"points": pointsArray,
		"count":  result.Count,
	})
}

// decodePointsBatch decodes multiple point strings at once for better performance
func decodePointsBatchJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return js.ValueOf(map[string]interface{}{
			"error": "Missing array of base64 data",
		})
	}

	array := args[0]
	length := array.Length()
	results := make([]interface{}, length)

	for i := 0; i < length; i++ {
		base64Data := array.Index(i).String()
		result, err := decodePoints(base64Data)

		if err != nil {
			results[i] = map[string]interface{}{
				"error": err.Error(),
			}
			continue
		}

		pointsArray := make([]interface{}, len(result.Points))
		for j, p := range result.Points {
			pointsArray[j] = map[string]interface{}{
				"x":        p.X,
				"y":        p.Y,
				"pressure": p.Pressure,
				"flags":    p.Flags,
			}
		}

		results[i] = map[string]interface{}{
			"points": pointsArray,
			"count":  result.Count,
		}
	}

	return js.ValueOf(results)
}

// parseColor converts Flexcil's color format (ARGB int) to CSS rgba
func parseColorJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return js.ValueOf("rgba(0,0,0,1)")
	}

	colorInt := uint32(args[0].Int())

	// Flexcil uses ARGB format
	a := (colorInt >> 24) & 0xFF
	r := (colorInt >> 16) & 0xFF
	g := (colorInt >> 8) & 0xFF
	b := colorInt & 0xFF

	alpha := float64(a) / 255.0

	return js.ValueOf(map[string]interface{}{
		"r":   r,
		"g":   g,
		"b":   b,
		"a":   alpha,
		"css": formatCSS(r, g, b, alpha),
	})
}

func formatCSS(r, g, b uint32, a float64) string {
	return "rgba(" +
		itoa(int(r)) + "," +
		itoa(int(g)) + "," +
		itoa(int(b)) + "," +
		ftoa(a) + ")"
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	result := ""
	for i > 0 {
		result = string('0'+byte(i%10)) + result
		i /= 10
	}
	return result
}

func ftoa(f float64) string {
	i := int(f * 100)
	whole := i / 100
	frac := i % 100
	if frac == 0 {
		return itoa(whole)
	}
	return itoa(whole) + "." + itoa(frac)
}

// analyzePointsFormat helps debug the points format by returning raw bytes
func analyzePointsFormatJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return js.ValueOf(map[string]interface{}{
			"error": "Missing base64 data argument",
		})
	}

	base64Data := args[0].String()
	data, err := base64.StdEncoding.DecodeString(base64Data)

	if err != nil {
		return js.ValueOf(map[string]interface{}{
			"error": err.Error(),
		})
	}

	// Return first 64 bytes as hex for analysis
	hexBytes := make([]interface{}, min(64, len(data)))
	for i := 0; i < len(hexBytes); i++ {
		hexBytes[i] = int(data[i])
	}

	return js.ValueOf(map[string]interface{}{
		"totalBytes": len(data),
		"firstByte":  int(data[0]),
		"bytes":      hexBytes,
	})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// parseFlxInfo parses the info JSON and extracts key metadata
func parseFlxInfoJS(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return js.ValueOf(map[string]interface{}{
			"error": "Missing JSON string argument",
		})
	}

	jsonStr := args[0].String()
	var info map[string]interface{}

	if err := json.Unmarshal([]byte(jsonStr), &info); err != nil {
		return js.ValueOf(map[string]interface{}{
			"error": err.Error(),
		})
	}

	return js.ValueOf(info)
}

func main() {
	// Register functions to be callable from JavaScript
	js.Global().Set("FlexcilWasm", js.ValueOf(map[string]interface{}{
		"decodePoints":        js.FuncOf(decodePointsJS),
		"decodePointsBatch":   js.FuncOf(decodePointsBatchJS),
		"parseColor":          js.FuncOf(parseColorJS),
		"analyzePointsFormat": js.FuncOf(analyzePointsFormatJS),
		"parseFlxInfo":        js.FuncOf(parseFlxInfoJS),
	}))

	// Keep the program running
	<-make(chan bool)
}
