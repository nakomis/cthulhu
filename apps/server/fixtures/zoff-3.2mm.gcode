; Elegoo Mars 5 Ultra: stock values + 3.2 mm for a magnetic flex plate (3.1-3.2 mm stack)
;M5000 I4 X21.000000 ;The maximum abnormal line in the actual resin detection stage (mm)
M5000 I4 X24.200000

;M5000 I4 Y3.000000 ;The minimum abnormal line in the actual resin detection stage (mm)
M5000 I4 Y6.200000

;M5000 I204 A35.000000 ;Resin detection starting position (mm), at least greater than the highest liquid level position on the structure to start measurement.
M5000 I204 A38.200000

;M5000 I204 B2.000000 ;Resin detection end position (mm), it is recommended to set 1mm or 2mm. Don't stick to the bottom, too close to the bottom will cause misjudgment due to the stress of the membrane.
M5000 I204 B5.200000

;M5000 I205 A2.000000 ;Starting position of automatic leveling (mm), it is recommended to be greater than 1mm, and start to level at the place where the film does not produce stress on the platform.
M5000 I205 A5.200000

;M5000 I205 B-2.000000 ;Ending position of automatic leveling (mm), it is recommended to set -1mm, too large may damage the screen.
M5000 I205 B1.200000

M5999 I0 ;Save configuration
