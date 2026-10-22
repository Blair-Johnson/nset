import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from support import Server
from nset_client import APIError
from images import frame_png


class ImageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server().start()
        cls.client = cls.server.client

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def test_native_bytes_timeline_and_auth(self):
        run = self.client.start_run(self.client.experiment("images"), "sequence")
        source = frame_png(0.5, width=40, height=32)
        rows = [run.log_image_bytes("../../prediction", source, step=step) for step in (100, 0, 50)]
        timeline = self.client.http.request("GET", run.path + "/images", query={"key": "../../prediction"})
        self.assertEqual([row["step"] for row in timeline["images"]], [0, 50, 100])
        self.assertEqual(len({row["id"] for row in rows}), 3)
        path = "/api/images/" + rows[0]["id"] + "/content"
        with self.assertRaises(HTTPError) as caught:
            urlopen(self.server.url + path)
        self.assertEqual(caught.exception.code, 401)
        request = Request(self.server.url + path, headers={"Authorization": "Bearer " + self.server.token})
        with urlopen(request) as response:
            self.assertEqual(response.read(), source)
            self.assertEqual(response.headers.get_content_type(), "image/png")
            self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
            self.assertIn("private", response.headers.get("Cache-Control", ""))
        self.server.stop()
        self.server.start()
        self.assertEqual(self.client.http.request("GET", path, binary=True), source)

    def test_reject_html_svg_and_corrupt_images(self):
        run = self.client.start_run(self.client.experiment("images"), "invalid")
        for data, mime in [(b"<html>bad</html>", "text/html"),
                           (b"<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml"),
                           (b"not an image", "image/png"),
                           (frame_png(0, width=2, height=2), "image/jpeg")]:
            with self.assertRaises(APIError) as caught:
                run.log_image_bytes("invalid", data, step=0, content_type=mime)
            self.assertIn(caught.exception.status, (400, 415, 422))
        self.assertEqual(self.client.http.request("GET", run.path + "/images")["images"], [])


if __name__ == "__main__":
    unittest.main()
